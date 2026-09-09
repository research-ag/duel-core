// The public, WebSocket-shaped surface for the embedded-gateway
// transport — this is what `../ws.js` hands back from `connectWs()`, and
// the ONLY transport this package ships (there is no plain-polling
// fallback — a canister built on this framework has no plain mutating
// method to poll in the first place, see `../../backend/src/Ws.mo`'s doc
// header). Owns the poll loop, the open/reconnect policy, and
// request/response correlation; delegates byte-moving to
// `gateway-transport.js` and message meaning to `gateway-protocol.js`
// (see both files' own headers for why that split exists — a future
// real-Gateway-backed transport swaps in under this same class
// untouched).
//
// Exposes a standard WebSocket-like surface (`onopen`/`onmessage`/
// `onerror`/`onclose`, `send(msg)`) PLUS `request(sid, req)` — a Promise
// of this specific call's own `{view}`/`{err}`, correlated by `reqId`
// rather than assumed to be whatever arrives next (see `request()`'s own
// doc below for why: this same connection routinely also carries
// unsolicited pushes from the OTHER seat acting). `../app.js` and any
// game code sharing this `ws` (see
// `examples/racing/frontend/.../lobby-connection.service.ts`) rely on
// exactly this surface.

import type { Principal } from "@icp-sdk/core/principal";
import { SelfGatewayTransport, type WsActor } from "./gateway-transport.js";
import { GatewayProtocol } from "./gateway-protocol.js";
import type { BuildGameTypes } from "../idl.js";
import type { DuelWs, WsPayload, WsRequest } from "../types.js";

const DEFAULT_INTERVAL_MS = 500;

/// How long a `request()` waits for its correlated reply before giving
/// up for good — see `request()`'s own doc for why this is a backstop,
/// not the normal path: on a genuine send failure the reply usually
/// still shows up well before this fires.
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

interface PendingRequest {
  resolve: (payload: WsPayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayWs extends EventTarget implements DuelWs {
  private _transport: SelfGatewayTransport;
  private _protocol: GatewayProtocol;
  private _intervalMs: number;
  private _requestTimeoutMs: number;
  private _sid: string | null;
  private _closed: boolean;
  // Whether the CDK's own #OpenMessage has arrived at least once — kept
  // only as a piece of connection-state bookkeeping now (see the doc on
  // `_handle()`'s "open" case for why `onopen` itself no longer gates on
  // it: a self-healed RECONNECT sends a brand new #OpenMessage too, and
  // `onopen` fires again for it on purpose).
  private _opened: boolean;
  private _pollTimer: ReturnType<typeof setTimeout> | null;
  private _ticking: boolean; // re-entrancy guard for _tick() — see _pollSoon()
  private _wantsAnotherTick: boolean;
  // In-flight request()s, keyed by the reqId THIS call made up — see
  // request()'s own doc and Ws.mo's "The wire protocol" section for why
  // this can no longer be a plain FIFO: a `#view`/`#err` this connection
  // receives is routinely NOT a reply to anything of ours at all (the
  // OTHER seat acting pushes here too — see Ws.mo's pushRelevant), so
  // matching "the next message" to "the oldest pending request" let an
  // unrelated broadcast steal a real reply's slot, hanging the actual
  // caller forever while resolving with someone else's payload.
  private _pending: Map<bigint, PendingRequest>;
  private _nextReqId: bigint; // BigInt, matches the wire's Nat64 — see idl.js's WsMsg
  // App messages a `send()`/`request()` built but never got a confirmed
  // transmission for — see `_queueResend()`'s own doc. Flushed the moment
  // this connection is next confirmed open (the "open" case in
  // `_handle()`), since a message queued here was, by construction, never
  // actually seen by `Ws.mo`'s `onMessage` (see that method's own doc for
  // why that's a DIFFERENT case from a reply merely arriving late).
  private _resendQueue: Array<{ sid: string; req: WsRequest; reqId: bigint | null }>;
  private _erroredSinceSuccess: boolean;
  // Consecutive failures since the last successful round trip — see
  // _reportError()'s own doc for why onerror only fires once this
  // reaches 2, not on every single one.
  private _consecutiveFailures: number;
  private _opening: Promise<void> | null; // in-flight _ensureOpen() promise, if any — see its own doc
  private _sendChain: Promise<void>; // serializes every outgoing ws_message — see _serialSend()
  private _onHide?: () => void;

  onopen: (() => void) | null;
  onmessage: ((ev: { data: WsPayload }) => void) | null;
  onerror: ((ev: { error?: Error }) => void) | null;
  onclose: (() => void) | null;

  constructor({
    actor,
    principal,
    gameIdlTypes,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    actor: WsActor;
    principal: Principal;
    gameIdlTypes: BuildGameTypes;
    intervalMs?: number;
    requestTimeoutMs?: number;
  }) {
    super();
    if (!actor) throw new Error("GatewayWs: `actor` is required");
    if (!principal) throw new Error("GatewayWs: `principal` is required");
    if (!gameIdlTypes) throw new Error("GatewayWs: `gameIdlTypes` is required");

    this._transport = new SelfGatewayTransport({ actor, principal });
    this._protocol = new GatewayProtocol({ gameIdlTypes });
    this._intervalMs = intervalMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this._sid = null;
    this._closed = false;
    this._opened = false;
    this._pollTimer = null;
    this._ticking = false;
    this._wantsAnotherTick = false;
    this._pending = new Map();
    this._nextReqId = 1n;
    this._resendQueue = [];
    this._erroredSinceSuccess = false;
    this._consecutiveFailures = 0;
    this._opening = null;
    this._sendChain = Promise.resolve();

    // Assignable by the caller, same as a real WebSocket.
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    // Start on the next tick, not synchronously — so a caller that
    // assigns onopen/onmessage/... right after construction (the normal
    // pattern) has already done so by the time anything fires.
    setTimeout(() => this._tick(), 0);

    // Best-effort cooperative goodbye for an actual tab-close/navigation-
    // away — the CDK's own keep-alive timeout is the backstop for
    // everything this can't catch (crash, force-quit, network drop — see
    // ../../backend/src/Ws.mo's doc header on that detection floor).
    // Deliberately `pagehide` only, NOT `visibilitychange`: a closed `ws`
    // drives an implicit server-side `TP.leave` the instant it fires (see
    // `Ws.mo`'s `onClose`), which immediately aborts a live game into a
    // shared debrief — `visibilitychange` fires on plain backgrounding
    // (switching tabs, minimizing, an OS-level app switch on mobile),
    // something a player does constantly mid-match with every intention
    // of coming right back; wiring that to a real close was a genuine bug
    // that ended an active match the instant either player merely
    // glanced at another tab.
    if (typeof addEventListener === "function") {
      this._onHide = () => this._transport.close();
      addEventListener("pagehide", this._onHide);
    }
  }

  /// The one loop driving everything: redo the `ws_open` handshake if
  /// this transport isn't currently registered, poll for whatever
  /// arrived, react to each envelope, then reschedule itself. ANY
  /// failure (open, poll, or a reaction's own send) invalidates the
  /// transport's registration so the NEXT tick redoes the handshake from
  /// scratch — simpler than trying to classify which errors specifically
  /// mean "the canister forgot us" (e.g. after an upgrade wiped `Ws.mo`'s
  /// transient state) versus a transient network blip, at the cost of a
  /// redundant `ws_open` on the rare blip that didn't actually need one
  /// (harmless — the CDK's own `ws_open` already handles superseding a
  /// still-registered client of the same principal).
  private async _tick(): Promise<void> {
    // Re-entrancy guard: `_pollSoon()` (see below) can be asked to wake
    // the loop up while a tick is already in flight — record the ask
    // instead of starting a SECOND, overlapping `_tick()`, which would
    // reopen exactly the class of bug this whole design exists to avoid:
    // two independent fetches delivering out of order, so a subscriber
    // briefly sees a STALE view overwrite a fresher one already shown
    // (see `examples/racing/CLAUDE.md`'s "cars occasionally animated
    // backwards" history for a real, previously-shipped instance of this
    // failure mode). This class has exactly one poll loop, so it can't
    // recur here.
    if (this._closed || this._ticking) {
      this._wantsAnotherTick = true;
      return;
    }
    this._ticking = true;
    let fast = false;
    try {
      await this._ensureOpen();
      const { envelopes, isEndOfQueue } = await this._transport.poll();
      this._markAlive();
      for (const envelope of envelopes) await this._handle(envelope);
      fast = !isEndOfQueue; // more waiting right now — don't wait a full tick
    } catch (e) {
      this._reportError(e as Error);
      this._transport.invalidate();
    }
    this._ticking = false;
    if (this._wantsAnotherTick) {
      this._wantsAnotherTick = false;
      fast = true;
    }
    if (!this._closed) {
      this._pollTimer = setTimeout(() => this._tick(), fast ? 0 : this._intervalMs);
    }
  }

  /// Redoes the `ws_open` handshake if the transport isn't currently
  /// registered, coalescing concurrent callers onto ONE in-flight open
  /// instead of racing two independent ones. `_tick()` (above) is one
  /// caller; `send()`/`request()` (below) are the other — a caller can
  /// invoke either right after construction, before the very first
  /// scheduled `_tick()` has even run, so without this a message built
  /// from `this._transport.clientKey` (still `null` at that point) got
  /// sent with a null `client_key`, rejected deep in the canister's own
  /// Candid decoder as "Invalid record ... Cannot read properties of
  /// null" — a real bug this coalescing exists to close, not a
  /// hypothetical one. Safe to call whether or not opening is already
  /// under way: every caller awaits the SAME promise.
  private _ensureOpen(): Promise<void> {
    if (this._transport.isOpen) return Promise.resolve();
    if (!this._opening) {
      const clientNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
      this._opening = this._transport
        .open(clientNonce)
        .then(() => this._protocol.resetSequence())
        .finally(() => {
          this._opening = null;
        });
    }
    return this._opening;
  }

  /// Sends one already-built `WebsocketMessage` record, serialized behind
  /// every other outgoing send on this connection. `ic-websocket-cdk`
  /// tracks a strict per-connection expected sequence number and evicts
  /// the client outright (`WrongSequenceNumber`, surfacing here as
  /// `onclose`/"Connection closed — reload to reconnect") the instant a
  /// message arrives out of order (see `ic-websocket-cdk`'s own
  /// `lib.mo`) — and TWO independent `ws_message` update calls, once
  /// both are in flight, have no guaranteed relative arrival/processing
  /// order on the IC, regardless of which was dispatched first. Without
  /// this, the periodic keep-alive ack-reply (fired from `_tick()`'s own
  /// poll handling, see the "ack" case below) and a user-triggered
  /// `send()`/`request()` could both have a `ws_message` call in flight
  /// at once — a real, load-dependent race, not a hypothetical one; the
  /// more actively a game is being played (more submits racing the
  /// periodic ack cycle), the more often it fires. Chaining every send
  /// onto the SAME promise means the next one is only ever dispatched
  /// once the previous has fully completed (or failed) — real added
  /// latency per message, but that is what a strict sequence protocol
  /// requires. A failed send doesn't break the chain for whatever comes
  /// after it (`.catch(() => {})`); the failure itself still propagates
  /// to THIS call's own caller via the returned promise.
  private _serialSend(record: Parameters<SelfGatewayTransport["send"]>[0]): Promise<void> {
    const result = this._sendChain.then(() => this._transport.send(record));
    this._sendChain = result.catch(() => {});
    return result;
  }

  /// Reacts to a failed `ws_message` (an ack-reply, `send()`, or
  /// `request()`) the same way `_tick()` already reacts to a failed
  /// poll: presumptively treat it as the canister having forgotten this
  /// registration, and redo the `ws_open` handshake right away rather
  /// than continuing to hammer a connection that "looks" open
  /// client-side (`clientKey` still set) but the canister has already
  /// stopped recognizing. This is defense in depth, not a fix on its
  /// own, for a real `ic-websocket-cdk@0.4.1` cleanup bug: `remove_client`
  /// in its `State.mo` deletes `CURRENT_CLIENT_KEY_MAP` by PRINCIPAL
  /// alone, not scoped to the exact `client_key` being removed — so a
  /// stale, delayed `ws_close`/eviction for an OLD registration that
  /// shares a principal with a NEW, live one (e.g. a caller building its
  /// agent with an identity kept stable across a reload — DON'T do that,
  /// see the callers of this file for the worked example and why) can
  /// silently erase the NEW connection's own principal->client_key
  /// mapping even though nothing is actually wrong with it. The visible
  /// symptom is exactly `ws_message: Client with principal ... doesn't
  /// have an open connection` — without this, that error just got
  /// reported and left to rot until the canister's OWN 60s keep-alive
  /// timeout finally evicted it for real (a `KeepAliveTimeout` this
  /// client could never successfully ack once its outgoing messages
  /// started failing), surfacing as a much-delayed, confusing
  /// "Connection closed — reload to reconnect." A fresh `ws_open` (a
  /// brand new `client_key`) unconditionally repopulates
  /// `CURRENT_CLIENT_KEY_MAP` for this principal, so IF this ever
  /// happens, recovery takes about one poll interval instead of up to
  /// 60-120s — but the real fix is not sharing a principal across two
  /// registrations in the first place; this alone was tried and did NOT
  /// resolve the issue in practice when the identity was still
  /// sid-derived, which is why that approach was reverted rather than
  /// kept and relied on this to paper over it.
  private _invalidateAndRetry(): void {
    this._transport.invalidate();
    this._pollSoon();
  }

  /// Remembers one app message (`send()`'s fire-and-forget push or
  /// `request()`'s own correlated call) that never got a confirmed
  /// transmission — the send itself failed, or the connection couldn't
  /// even be (re)opened at all in order to attempt it. Distinct from
  /// waiting for a "late reply" (see `request()`'s own extensive doc on
  /// that): THIS failure mode means the message never reached `Ws.mo`'s
  /// `onMessage` in the first place — most commonly `ws_message`'s own
  /// "Client ... doesn't have an open connection" (this transport's
  /// `clientKey` looked locally valid but the canister had already
  /// forgotten the registration — a keep-alive eviction, a canister
  /// upgrade wiping `Ws.mo`'s transient state, or the
  /// `remove_client`-by-principal quirk `_invalidateAndRetry()`'s own doc
  /// describes) — so no reply is EVER coming for it, and simply waiting
  /// silently drops the action (a real, observed bug: a "Return to lobby"
  /// / `ackEnded` click that appeared to do nothing at all). Queued
  /// entries are resent from scratch — a fresh `clientKey` and outgoing
  /// sequence number, since both are stale after a reconnect — the next
  /// time this connection is confirmed open again (see `_handle()`'s
  /// "open" case's own doc). Safe to retry: every mutating request this
  /// package sends (`join`/`submit`/`rematch`/`leave`/`reset`/`ackEnded`)
  /// is already gated by the engine's own idempotent/legality checks (see
  /// `../../backend/src/lib.mo`'s architecture rule 4), so a resend that
  /// turns out to race an original attempt that secretly DID land just
  /// comes back as a harmless `#err` instead of a corrupting duplicate.
  private _queueResend(sid: string, req: WsRequest, reqId: bigint | null): void {
    this._resendQueue.push({ sid, req, reqId });
  }

  /// Resends everything `_queueResend()` collected, called once this
  /// connection is confirmed freshly open again (see `_handle()`'s "open"
  /// case). Drains the queue up front so a resend that itself fails
  /// re-queues into a clean array rather than fighting over the one
  /// `_flushResendQueue()` is currently iterating.
  private _flushResendQueue(): void {
    if (this._closed || !this._resendQueue.length) return;
    const queued = this._resendQueue;
    this._resendQueue = [];
    for (const { sid, req, reqId } of queued) {
      const record = this._protocol.buildAppMessage(this._transport.clientKey, sid, req, reqId);
      this._serialSend(record).then(
        () => this._pollSoon(),
        (e) => {
          console.debug("[duel-ws] resend after reconnect failed, will retry on the next one:", e && e.message ? e.message : e);
          this._queueResend(sid, req, reqId);
          this._invalidateAndRetry();
        },
      );
    }
  }

  /// True for an `#err` that can ONLY mean "this exact mutation already
  /// landed (or the world has moved on since)", never a fresh, first-
  /// attempt failure. `_queueResend()` retries a mutation whose own
  /// `ws_message` call failed client-side with no way to tell whether the
  /// message actually reached `Ws.mo`'s `onMessage` first (see that
  /// method's own doc) — when it turns out it did, the RESENT copy comes
  /// back rejected with one of these two, even though the original click
  /// already succeeded:
  ///   - `#alreadySubmitted` — the original `submit` landed and the round
  ///     hasn't moved on yet, so the resend collides with its own pending
  ///     slot directly.
  ///   - `#stale` — the original landed AND the match/round has since
  ///     moved on (the round resolved, or — for `leave`/`reset` — a brand
  ///     new match started) before the resend was processed; the engine's
  ///     `gen`/`turn` check catches this (see `../../backend/src/lib.mo`'s
  ///     `Table.gen` doc) instead of silently replaying the resend against
  ///     whatever is current now.
  /// Every other `EngineErr` variant is ambiguous (a genuinely fresh
  /// #seatTaken/#notIdle/etc. is just as plausible as a stale resend), so
  /// only these two are worth reconciling rather than surfacing as-is.
  private _isRetryAmbiguousError(payload: WsPayload): boolean {
    return "err" in payload && ("alreadySubmitted" in payload.err || "stale" in payload.err);
  }

  /// A resent mutation's own reply came back `#alreadySubmitted`/`#stale`
  /// — see `_isRetryAmbiguousError`'s own doc for why that means the
  /// ORIGINAL attempt already succeeded server-side. Handing the caller
  /// that raw error would make today's click look like it failed when it
  /// didn't (the exact "spurious Call failed toast" class of bug
  /// `request()`'s own doc already guards against for a different race),
  /// so fetch a fresh `#status` view instead and settle the caller's
  /// pending promise with THAT, same as if the original attempt's own
  /// reply had simply arrived a little late.
  private _resolveAfterReconcile(p: PendingRequest): void {
    if (this._sid == null) {
      p.resolve({ err: { alreadySubmitted: null } });
      return;
    }
    this.request(this._sid, { status: null }).then(
      (fresh) => p.resolve(fresh),
      (e) => p.reject(e as Error),
    );
  }

  /// Wakes the poll loop up right away instead of leaving it to wait out
  /// up to `intervalMs` — called right after `send()`/`request()`
  /// transmits a message. By the time `ws_message` resolves, `Ws.mo`'s
  /// `onMessage` has ALREADY pushed the resulting view into our own
  /// outgoing queue server-side (same update call, before it returns) —
  /// without this, picking it up could lag by nearly a full `intervalMs`
  /// for no reason. That extra lag is exactly what let a real bug
  /// through: `examples/racing`'s own
  /// animation for the LOCAL player's car is driven by a client-side
  /// PREDICTED trajectory captured at click-time (see
  /// `lobby-connection.service.ts`'s `buildSteps()`), not by this
  /// connection at all — but that prediction is only as good as the
  /// on-screen car position IS at click-time, and a click landing before
  /// this connection had caught up to the PREVIOUS move's own resolved
  /// server state made the next prediction start from a stale baseline
  /// (visually: the car animating "backwards" before snapping to the
  /// correct final position once the real values overwrite the
  /// prediction's endpoint). Closing this gap doesn't touch that
  /// game-specific prediction logic at all — it just makes this
  /// connection catch up to the canister's own state right after this
  /// connection's own mutating call resolves, shrinking the race window
  /// back down instead of leaving it to the next periodic tick.
  private _pollSoon(): void {
    if (this._closed) return;
    if (this._ticking) {
      this._wantsAnotherTick = true;
      return;
    }
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._tick(), 0);
  }

  private async _handle(
    envelope: Parameters<GatewayProtocol["interpret"]>[0],
  ): Promise<void> {
    const action = this._protocol.interpret(envelope);
    // TEMPORARY diagnostic — remove once the "other seat's push never
    // arrives" bug is root-caused.
    console.debug("[duel-ws] handle kind=%s reqId=%s", action.kind, "reqId" in action ? action.reqId : undefined);
    switch (action.kind) {
      case "open": {
        // Fires on EVERY confirmed (re)open, not just the first — a
        // self-healed reconnect (any failed poll/send invalidates the
        // transport and redoes the `ws_open` handshake from scratch, see
        // `_tick()`'s own doc) gets a brand new #OpenMessage from the CDK
        // exactly like the very first connection did, and needs to be
        // told apart from steady-state operation the same way: this is
        // the ONLY hook a caller has (`app.js`'s `ws.onopen = () =>
        // refresh()`) to resync its own view after a gap in the
        // connection — without re-firing here, a caller that only ever
        // resyncs on `onopen` never learns a reconnect happened at all,
        // and can be left showing a stale view (e.g. a still-connected
        // tab that missed the push for a game the idle-sweep timer froze
        // out from under it — see `../../backend/src/ActorMixin.mo`'s
        // `sweepFunc`, which has no WS/push awareness of its own) until
        // its OWN next mutating action, whose `#err` reply doesn't
        // re-render anything either. A previous version of this method
        // fired `onopen` only once ever (guarded by `_opened`), on the
        // mistaken assumption that a caller shouldn't have to care that
        // this class silently reconnects underneath it — real gap, not
        // hypothetical.
        this._opened = true;
        if (this.onopen) this.onopen();
        this.dispatchEvent(new Event("open"));
        this._flushResendQueue();
        break;
      }
      case "ack": {
        // Reply immediately — this IS the mechanism behind the
        // disappearance detection in ../../backend/src/Ws.mo: silence
        // here (crash, force-quit, network drop) is what the canister's
        // keep-alive timeout is watching for.
        try {
          const reply = this._protocol.buildKeepAliveReply(
            this._transport.clientKey,
            action.lastIncomingSequenceNum,
          );
          await this._serialSend(reply);
        } catch (e) {
          this._reportError(e as Error);
          this._invalidateAndRetry();
        }
        break;
      }
      case "close": {
        // The canister told US to go away (keep-alive timeout, a wrong
        // sequence number, or superseded by a fresh ws_open with the
        // same principal) — same visible effect as our own close(), but
        // there's no live registration left to say goodbye to.
        this._teardown();
        break;
      }
      case "message": {
        // Always deliver generically first — a game's own `onmessage`
        // listener (and app.js's own fire-and-forget refresh()) needs
        // every push regardless of whether it's also someone's `request()`
        // reply. Only THEN check for a matching pending request, by the
        // reqId Ws.mo echoed back — `null` means this was never a reply to
        // anything of ours (an unsolicited broadcast; see this._pending's
        // own doc), so there's nothing to resolve.
        this._deliver(action.payload);
        if (action.reqId != null) {
          const p = this._pending.get(action.reqId);
          if (p) {
            this._pending.delete(action.reqId);
            clearTimeout(p.timer);
            if (this._isRetryAmbiguousError(action.payload)) {
              this._resolveAfterReconcile(p);
            } else {
              p.resolve(action.payload);
            }
          }
        }
        break;
      }
      case "unknown":
        break;
    }
  }

  /// WebSocket-compatible, fire-and-forget send. Accepts exactly the
  /// shape `app.js` sends: `{ req: { sid, req } }`, where `req` mirrors
  /// `Ws.Request<M>` on the backend (`{join}`/`{submit}`/`{rematch}`/
  /// `{leave}`/`{reset}`/`{ackEnded}`/`{status}`). The eventual result
  /// only ever surfaces as a `message`/`error` event, same as a real
  /// WebSocket — use `request()` instead if you need this specific
  /// call's own response.
  ///
  /// Awaits `_ensureOpen()` before building the record — `clientKey` is
  /// `null` until the transport's first successful `ws_open`, and this
  /// can be called before that's happened (e.g. right after construction,
  /// ahead of the very first scheduled `_tick()` — see `_ensureOpen()`'s
  /// own doc for the bug that produced).
  send(msg: { req?: { sid: string; req: WsRequest } }): void {
    if (this._closed) return;
    const envelope = msg?.req;
    if (!envelope) return;
    const { sid, req } = envelope;
    this._sid = sid;
    this._ensureOpen().then(
      () => {
        // `reqId: null` — nothing awaits this call's own reply (that's the
        // whole point of `send()`), so it needs no correlation token; its
        // eventual push (if any) is delivered generically like any other,
        // same as an unsolicited broadcast from the other seat.
        const record = this._protocol.buildAppMessage(this._transport.clientKey, sid, req, null);
        this._serialSend(record).then(
          () => this._pollSoon(),
          (e) => {
            this._reportError(e);
            // The message never reached `Ws.mo`'s `onMessage` — see
            // `_queueResend()`'s own doc — so it needs an actual resend
            // once reconnected, not just a reconnect on its own.
            this._queueResend(sid, req, null);
            this._invalidateAndRetry();
          },
        );
      },
      (e) => {
        this._reportError(e);
        this._queueResend(sid, req, null);
        this._invalidateAndRetry();
      },
    );
  }

  /// Like `send()`, but resolves with THIS call's own `{view}`/`{err}` —
  /// `app.js`'s `call()` relies on exactly this to settle a button's own
  /// spinner off ITS OWN response rather than off whatever the shared
  /// push stream delivers next (see `app.js`'s "Calls" section). This
  /// resolves off the shared push stream: a fresh `reqId` is minted for
  /// this call and `Ws.mo` echoes it back verbatim on the resulting
  /// `#view`/`#err` (see `../idl.js`'s `WsMsg` doc and
  /// `../../backend/README.md`'s "The wire protocol" section) — `_handle()`
  /// matches replies by that id instead of assuming the next message
  /// belongs to the oldest pending call, so any number of `request()`s
  /// (from this class's own callers, and any OTHER code sharing this same
  /// `ws` — see `lobby-connection.service.ts`) can be genuinely in flight
  /// at once, interleaved with unsolicited pushes from the other seat
  /// acting, with no risk of one stealing another's reply.
  ///
  /// Does NOT reject just because the `ws_message` update call itself
  /// throws. That call's own client-side round trip can fail on its own
  /// — most commonly `@icp-sdk/core/agent`'s own actor wrapper throwing
  /// "Call was returned undefined, but type ..." when a slow/cold-starting
  /// canister blows past its certificate-polling budget (see
  /// `_reportError()`'s own doc: "confirmed live", and self-healing
  /// there within about one tick) — WITHOUT that meaning the request
  /// itself failed: an update call reaching the canister at all means
  /// `Ws.mo`'s `onMessage` already ran and already queued this call's
  /// reply, before the call returns anything to us. A real, observed
  /// sequence, not a hypothetical one: a user hit Leave, the `ws_message`
  /// call threw that exact decode error client-side, and the
  /// correctly-processed reply (matching this same `reqId`) still showed
  /// up moments later over the reconnected transport. Rejecting
  /// immediately off that `_serialSend` failure — the naive choice —
  /// would have shown `call()` in `app.js` a spurious "Call failed" toast
  /// right then, with the real reply arriving later to an already-deleted
  /// pending entry and an already-rejected promise, nowhere to land. So:
  /// on a `_serialSend` failure, force the same reconnect
  /// `_invalidateAndRetry()` already does for a failed poll/ack, but
  /// leave the pending entry in place — `_handle()`'s "message" case
  /// above still resolves it normally once the (very likely already
  /// queued) reply is observed. The timeout below is only the backstop
  /// for a request that genuinely never reached the canister at all.
  ///
  /// Registers the pending entry BEFORE attempting to (re)open/send —
  /// see the comment inside the executor for why registering late misses
  /// a real race, and `_queueResend()`'s own doc for why a failed attempt
  /// gets RESENT (not just waited on) once the connection is confirmed
  /// open again, rather than rejecting immediately or hoping a reply
  /// shows up for a message that was never actually processed.
  request(sid: string, req: WsRequest): Promise<WsPayload> {
    if (this._closed) return Promise.reject(new Error("GatewayWs: closed"));
    this._sid = sid;
    const reqId = this._nextReqId++;
    return new Promise<WsPayload>((resolve, reject) => {
      // Register BEFORE dispatching the send, not after it resolves.
      // The reply gets enqueued into the canister's outgoing queue
      // the instant THIS SAME `ws_message` update call is processed
      // server-side — but `_tick()`'s own independent poll loop
      // (`ws_get_messages`, a query call) can observe and consume
      // that reply before OUR client-side `await` on the update call
      // itself resolves (a query round-trip can genuinely outrace an
      // update call's own certified-response polling). Setting
      // `_pending` only once `_serialSend` resolved missed exactly
      // that window: `_handle()`'s "message" case ran with nothing
      // registered yet, `_deliver()` still fired (so the UI updated
      // normally), but the reqId was never claimed — and since that
      // one-time reply had already come and gone, `request()`'s own
      // promise then hung forever with no way to ever resolve. Real,
      // not hypothetical: this is what made "take seat" visually
      // complete while `app.js`'s `inFlight` stayed stuck, silently
      // swallowing every subsequent button click (including Leave).
      const timer = setTimeout(() => {
        if (this._pending.delete(reqId)) {
          reject(new Error("GatewayWs: request timed out waiting for a reply"));
        }
      }, this._requestTimeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });

      this._ensureOpen().then(
        () => {
          const record = this._protocol.buildAppMessage(this._transport.clientKey, sid, req, reqId);
          this._serialSend(record).then(
            () => this._pollSoon(),
            (e) => {
              // Do NOT delete `_pending` or reject here. Unlike a plain
              // late-arriving-reply race, this specific failure (the
              // `ws_message` call itself erroring, e.g. "doesn't have an
              // open connection") means the message never reached
              // `Ws.mo`'s `onMessage` at all — so queue it for an actual
              // resend once reconnected (see `_queueResend()`'s own doc)
              // instead of just waiting for a reply that can now never
              // come; let the timeout above be the final backstop if
              // reconnecting keeps failing.
              console.debug("[duel-ws] request seq send failed, will resend once reconnected:", e && e.message ? e.message : e);
              this._queueResend(sid, req, reqId);
              this._invalidateAndRetry();
            },
          );
        },
        (e) => {
          console.debug("[duel-ws] request could not (re)open the connection, will resend once reconnected:", e && e.message ? e.message : e);
          this._queueResend(sid, req, reqId);
          this._invalidateAndRetry();
        },
      );
    });
  }

  /// True once closed (see `close()`) — a way to check without needing
  /// to have caught the `close` event at the moment it fired.
  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._transport.close(); // best-effort cooperative goodbye
    this._teardown();
  }

  private _teardown(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    if (this._onHide && typeof removeEventListener === "function") {
      removeEventListener("pagehide", this._onHide);
    }
    // Reject anything still waiting rather than leaving it hanging.
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("GatewayWs: closed"));
    }
    this._pending.clear();
    this._resendQueue = [];
    if (this.onclose) this.onclose();
    this.dispatchEvent(new Event("close"));
  }

  private _deliver(data: WsPayload): void {
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  private _markAlive(): void {
    this._erroredSinceSuccess = false;
    this._consecutiveFailures = 0;
  }

  // Fires onerror only once a SECOND consecutive failure lands with no
  // success in between (and then at most once per bad streak thereafter
  // — see _erroredSinceSuccess's own doc). A single failed tick is the
  // COMMON case, not an outage: _tick()'s own catch and
  // _invalidateAndRetry() (see their own doc) already invalidate and
  // redo the `ws_open` handshake right away, and that automatic retry
  // succeeding on its very next attempt is what usually happens — e.g. a
  // `ws_message` update call that blows past the IC agent's own
  // certificate-polling budget on a slow/cold-starting canister throws
  // deep inside `@icp-sdk/core/agent`'s own actor wrapper ("Call was
  // returned undefined..."), this connection invalidates and reopens,
  // and the next poll already recovers — all within about one tick,
  // confirmed live. Surfacing THAT lone blip to the caller's onerror
  // (app.js's `showError()` toast, in the reference examples) as if the
  // connection were actually broken was a real false alarm, not
  // hypothetical: a user-visible "WebSocket error" banner for something
  // already fixed by the time it rendered. Waiting for a second
  // consecutive failure means a lone blip that self-heals stays silent,
  // while a connection that's genuinely down still gets reported — just
  // one tick later than before, which is imperceptible against a real
  // outage.
  private _reportError(e: Error): void {
    // TEMPORARY diagnostic — remove once the "Expected incoming sequence
    // number" bug is root-caused. Logs every error this connection sees,
    // even ones that don't (yet, or ever) escalate to onerror below.
    console.debug("[duel-ws] error:", e && e.message ? e.message : e);
    this._consecutiveFailures++;
    if (this._consecutiveFailures < 2) return;
    if (this._erroredSinceSuccess) return;
    this._erroredSinceSuccess = true;
    if (this.onerror) this.onerror({ error: e });
    this.dispatchEvent(new Event("error"));
  }
}
