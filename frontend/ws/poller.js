// The push transport, dissolved down to one small class.
//
// Earlier versions of this package built real-time push the way
// `ic-websocket-cdk` intends: a browser opens an actual `WebSocket` to an
// off-chain Gateway process, which relays it to the canister's
// `ws_open`/`ws_message`/`ws_get_messages`/`ws_close` Candid methods (see
// `../../backend/src/Ws.mo`). That needed a Gateway server running
// somewhere and an `ic-websocket-js` dependency to speak its wire
// protocol.
//
// This module removes the Gateway and the SDK entirely. The browser
// already has everything it needs to reach the canister — its own
// `actor`, already wired with an agent and an identity by the caller — so
// `PollingWs` just calls the SAME plain 7-method surface `app.js` already
// knows how to drive without a `ws` (`join`/`submit`/`rematch`/`leave`/
// `reset`/`ackEnded`/`status`), on a fast interval, and re-shapes the
// results into the exact WebSocket-like surface `app.js`'s `ws` branch
// expects (`onopen`/`onmessage`/`onerror`/`onclose`, `send(msg)`,
// `{data: {view} | {err}}` messages — see `../app.js`'s header). Nothing
// downstream of `connectWs()` can tell the difference: `app.js` is
// unchanged, and `../../backend/src/Ws.mo`/`ic-websocket-cdk` are
// untouched but no longer needed for this to work — a canister only needs
// its plain 7 methods.
//
// `PollingWs` extends `EventTarget`, same as a real `WebSocket`, so it
// supports both single-slot handler assignment (`ws.onmessage = fn`, what
// `app.js` uses) AND `ws.addEventListener("message", fn)` for any number
// of additional subscribers — this is what lets a game's own gameplay
// code (not just the generic chrome) share ONE poller instead of running
// a second independent one; see `examples/racing/frontend/src/app/
// modules/gameplay/game-communication/services/lobby-connection.service.ts`
// for a worked example, and `request()` below for the piece that makes it
// safe to also correlate a specific call's own response (not just observe
// the general push stream). The periodic timer and every `request()`'s
// own post-action status fetch run concurrently with no ordering
// guarantee between them (ordinary network jitter can make an
// earlier-issued fetch resolve later) — `_fetchView()` tags each one with
// a sequence number at issuance and only ever broadcasts the
// highest-numbered one seen so far, so every `message` subscriber's view
// of the world stays monotonic even though the underlying fetches don't
// arrive in order.
//
// The tradeoff, honestly: this is polling wearing a push-shaped costume,
// not real server push. An opponent's move shows up on the next tick
// (`intervalMs`, default 500ms), not the instant it resolves. For a
// casual 2-player game that's an imperceptible difference and a much
// simpler stack — no Docker, no relay process, no signing identity, no
// second wire protocol to keep in sync with the plain one (see
// `../../CLAUDE.md`'s architecture rule 11, which this sidesteps by
// construction: there is only ever one transport now).
//
// Usage:
//
//   import { connectWs } from "duel-game-core/ws.js"; // re-exports this
//   const ws = connectWs({ actor });
//   start({ plugin, ws });

const DEFAULT_INTERVAL_MS = 500;

/// A WebSocket-shaped wrapper around fast polling of a plain
/// `duel-game-core` actor. See this file's header for the full story.
export class PollingWs extends EventTarget {
  constructor({ actor, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    if (!actor) throw new Error("PollingWs: `actor` is required");
    this._actor = actor;
    this._intervalMs = intervalMs;
    this._sid = null;
    this._timer = null;
    this._closed = false;
    // The periodic timer and each request()'s own post-action status
    // fetch are concurrent, independent actor.status() calls with no
    // ordering guarantee between them — one issued earlier can resolve
    // later (ordinary network jitter). Tagging each fetch with a
    // sequence number AT ISSUANCE, and only ever broadcasting the
    // highest-numbered one seen so far, keeps every `message` subscriber
    // monotonic regardless of completion order — see _fetchView().
    this._fetchSeq = 0;
    this._deliveredSeq = 0;

    // Assignable by the caller, same as a real WebSocket.
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    // No real handshake to wait for — "open" on the next tick, so a
    // caller that assigns onopen/onmessage/... right after construction
    // (the normal pattern) has already done so by the time it fires.
    setTimeout(() => {
      if (!this._closed && this.onopen) this.onopen();
    }, 0);
  }

  /// WebSocket-compatible, fire-and-forget send. Accepts exactly the
  /// shape `app.js` sends: `{ req: { sid, req } }`, where `req` is one of
  /// the plain engine requests (`{join}`/`{submit}`/`{rematch}`/
  /// `{leave}`/`{reset}`/`{ackEnded}`/`{status}`) — mirrors
  /// `Ws.Request<M>` on the backend, just never Candid-encoded: `actor`
  /// already speaks plain JS objects. The eventual result (or a
  /// transport-level failure) only ever surfaces as a `message`/`error`
  /// event, same as a real WebSocket — use `request()` instead if you
  /// need this specific call's own response correlated back to you.
  send(msg) {
    if (this._closed) return;
    const envelope = msg?.req;
    if (!envelope) return;
    const { sid, req } = envelope;
    this.request(sid, req).then(
      (payload) => {
        // request() itself never broadcasts an `err` payload (see its own
        // doc) — send() has to, since a fire-and-forget caller has no
        // other way to learn its own result. A `view` payload was
        // already broadcast by request() itself; nothing more to do.
        if ("err" in payload) this._deliver(payload);
      },
      async (e) => {
        if (this.onerror) this.onerror({ error: e });
        // A thrown error (network blip, agent failure) isn't necessarily
        // terminal — try once to recover a fresh view so the caller's
        // "working" state doesn't get stuck with no way out. If this
        // also fails, the error above already told the user something's
        // wrong.
        try {
          await this._fetchView(this._sid);
        } catch {
          // still down; nothing more to do here.
        }
      },
    );
  }

  /// Like `send()`, but returns a Promise of THIS call's own result —
  /// `{ view }` on success, `{ err }` if the engine rejected it — instead
  /// of only delivering it as a generic `message` event. Needed by
  /// anything that must react to its own request specifically (e.g. "was
  /// MY move rejected?") rather than just observing whichever view
  /// happens to arrive next — `send()`'s fire-and-forget messages race
  /// against this poller's own periodic tick, so they can't answer that
  /// question on their own. Rejects (never resolves) on a genuine
  /// transport failure (thrown by `actor`), same as calling `actor`
  /// directly would.
  ///
  /// An `{ err }` result is returned to THIS caller only — it is
  /// deliberately NOT broadcast as a `message` event. A caller using
  /// `request()` already has the answer directly; broadcasting it too
  /// would leak one caller's own rejection to every OTHER consumer
  /// sharing this poller (e.g. a game's own gameplay code retrying its
  /// own submit after an ambiguous failure, and the retry landing after
  /// the original actually succeeded — an expected, harmless outcome
  /// the retry logic already handles via this return value — used to
  /// also surface as a confusing "you already moved" toast on
  /// `app.js`'s generic chrome, since it shares this same poller and
  /// listens for exactly this event). A `{ view }` result IS still
  /// broadcast (via `_fetchView()`), since a fresh view is genuinely
  /// relevant to every consumer, not just this caller.
  async request(sid, req) {
    if (sid !== this._sid) {
      this._sid = sid;
      this._restartPolling();
    }
    const tag = Object.keys(req)[0];
    const val = req[tag];
    let res;
    switch (tag) {
      case "join":
        res = await this._actor.join(sid, val);
        break;
      case "submit":
        res = await this._actor.submit(sid, val);
        break;
      case "rematch":
        res = await this._actor.rematch(sid);
        break;
      case "leave":
        res = await this._actor.leave(sid);
        break;
      case "reset":
        res = await this._actor.reset(sid);
        break;
      case "ackEnded":
        res = await this._actor.ackEnded(sid);
        break;
      case "status":
        res = undefined;
        break;
      default:
        throw new Error(`PollingWs: unknown ws request "${tag}"`);
    }
    // ackEnded returns nothing; the Res-returning calls return {ok}/{err}
    // — same guard app.js's own non-ws call() uses.
    if (res && typeof res === "object" && "err" in res) {
      return { err: res.err }; // not broadcast — see this method's doc
    }
    // The caller (e.g. a game's own gameplay code correlating THIS
    // submit's result) always gets the actual view back, even if it lost
    // the race to be the one broadcast as the canonical `message` — see
    // _fetchView's own doc.
    return { view: await this._fetchView(sid) };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._timer);
    if (this.onclose) this.onclose();
  }

  _restartPolling() {
    clearInterval(this._timer);
    this._timer = setInterval(async () => {
      if (this._closed) return;
      try {
        await this._fetchView(this._sid);
      } catch (e) {
        if (this.onerror) this.onerror({ error: e });
      }
    }, this._intervalMs);
  }

  /// Fetches a fresh status view for `sid`, tagged with a sequence number
  /// assigned at ISSUANCE (not completion) — the periodic timer and a
  /// request()'s own post-action fetch are concurrent, independent
  /// actor.status() calls that can resolve in either order; broadcasting
  /// one whose sequence number is LOWER than the highest already
  /// broadcast would hand every `message` subscriber a step backwards
  /// — a real bug this fixed in `examples/racing`: cars occasionally
  /// animated backwards, then "teleported" once a later, correctly
  /// fresher tick corrected it. Always returns the actual view to ITS
  /// OWN caller regardless of whether it won the race to be broadcast.
  async _fetchView(sid) {
    const seq = ++this._fetchSeq;
    const view = await this._actor.status(sid);
    if (seq > this._deliveredSeq) {
      this._deliveredSeq = seq;
      this._deliver({ view });
    }
    return view;
  }

  _deliver(data) {
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/// Builds a ready-to-use `ws` for `app.js`'s `start()` — a `PollingWs`
/// wired to `actor`. See this file's header for what it actually does
/// (polling, not a real socket) and why. Always returns a `PollingWs` —
/// there is no polling-fallback escape hatch here; `ws` is the only
/// transport this package ships.
///
/// Options (all optional except `actor`):
///   intervalMs - how often to poll for a fresh view, in ms (default 500)
///   params     - URLSearchParams to read `wsInterval` from (default:
///                `new URLSearchParams(location.search)`)
///
/// `?wsInterval=<ms>` overrides `intervalMs`, handy for testing without
/// editing code.
///
/// Accepts (and ignores) `canisterId`/`host`/`gatewayUrl`/`identity` too
/// — no Gateway to pick or identity to sign with anymore — so existing
/// call sites written for the old Gateway-backed `connectWs()` keep
/// working unchanged.
export function connectWs({
  actor,
  intervalMs = DEFAULT_INTERVAL_MS,
  params = new URLSearchParams(location.search),
  ...ignored // canisterId, host, gatewayUrl, identity — see doc above
} = {}) {
  if (!actor) throw new Error("connectWs(): `actor` is required");

  const wsInterval = Number(params.get("wsInterval"));
  return new PollingWs({
    actor,
    intervalMs: wsInterval > 0 ? wsInterval : intervalMs,
  });
}
