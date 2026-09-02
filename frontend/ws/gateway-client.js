// The public, WebSocket-shaped surface for the embedded-gateway
// transport — this is what `../ws.js` hands back from `connectWs()`.
// Owns the poll loop, the open/reconnect policy, and request/response
// correlation; delegates byte-moving to `gateway-transport.js` and
// message meaning to `gateway-protocol.js` (see both files' own headers
// for why that split exists — a future real-Gateway-backed transport
// swaps in under this same class untouched).
//
// Mirrors `poller.js`'s `PollingWs` surface exactly (`onopen`/
// `onmessage`/`onerror`/`onclose`, `send(msg)`, `request(sid, req)`) so
// `../app.js` and any game code sharing this `ws` (see
// `examples/racing/frontend/.../lobby-connection.service.ts`) need no
// branching over which transport they got — see `poller.js`'s own
// header for the exact contract being matched.

import { SelfGatewayTransport } from "./gateway-transport.js";
import { GatewayProtocol } from "./gateway-protocol.js";

const DEFAULT_INTERVAL_MS = 500;

export class GatewayWs extends EventTarget {
  constructor({ actor, principal, gameIdlTypes, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super();
    if (!actor) throw new Error("GatewayWs: `actor` is required");
    if (!principal) throw new Error("GatewayWs: `principal` is required");
    if (!gameIdlTypes) throw new Error("GatewayWs: `gameIdlTypes` is required");

    this._transport = new SelfGatewayTransport({ actor, principal });
    this._protocol = new GatewayProtocol({ gameIdlTypes });
    this._intervalMs = intervalMs;
    this._sid = null;
    this._closed = false;
    this._opened = false; // has the CDK's own #OpenMessage arrived yet?
    this._pollTimer = null;
    this._pending = []; // FIFO of {resolve, reject} for in-flight request()s
    this._erroredSinceSuccess = false;

    // Assignable by the caller, same as a real WebSocket.
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    // Start on the next tick — matches PollingWs's own timing (see
    // poller.js) so a caller that assigns onopen/onmessage/... right
    // after construction has already done so by the time anything fires.
    setTimeout(() => this._tick(), 0);

    // Best-effort cooperative goodbye for a normal tab-close/backgrounding
    // — the CDK's own keep-alive timeout is the backstop for everything
    // this can't catch (crash, force-quit, network drop — see
    // ../../backend/src/Ws.mo's doc header on that detection floor).
    if (typeof document !== "undefined") {
      this._onHide = () => {
        if (document.visibilityState === "hidden") this._transport.close();
      };
      document.addEventListener("visibilitychange", this._onHide);
      if (typeof addEventListener === "function") {
        addEventListener("pagehide", this._onHide);
      }
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
  async _tick() {
    if (this._closed) return;
    let fast = false;
    try {
      if (!this._transport.isOpen) {
        const clientNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        await this._transport.open(clientNonce);
        this._protocol.resetSequence();
      }
      const { envelopes, isEndOfQueue } = await this._transport.poll();
      this._markAlive();
      for (const envelope of envelopes) await this._handle(envelope);
      fast = !isEndOfQueue; // more waiting right now — don't wait a full tick
    } catch (e) {
      this._reportError(e);
      this._transport.invalidate();
    }
    if (!this._closed) {
      this._pollTimer = setTimeout(() => this._tick(), fast ? 0 : this._intervalMs);
    }
  }

  async _handle(envelope) {
    const action = this._protocol.interpret(envelope);
    switch (action.kind) {
      case "open": {
        if (this._opened) break;
        this._opened = true;
        if (this.onopen) this.onopen();
        this.dispatchEvent(new Event("open"));
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
          await this._transport.send(reply);
        } catch (e) {
          this._reportError(e);
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
        this._deliver(action.payload);
        const p = this._pending.shift();
        if (p) p.resolve(action.payload);
        break;
      }
      case "unknown":
        break;
    }
  }

  /// WebSocket-compatible, fire-and-forget send. Accepts exactly the
  /// shape `app.js` sends: `{ req: { sid, req } }` — see poller.js's own
  /// doc for the full contract. The eventual result only ever surfaces
  /// as a `message`/`error` event, same as a real WebSocket — use
  /// `request()` instead if you need this specific call's own response.
  send(msg) {
    if (this._closed) return;
    const envelope = msg?.req;
    if (!envelope) return;
    const { sid, req } = envelope;
    this._sid = sid;
    const record = this._protocol.buildAppMessage(this._transport.clientKey, sid, req);
    this._transport.send(record).catch((e) => this._reportError(e));
  }

  /// Like `send()`, but resolves with THIS call's own `{view}`/`{err}` —
  /// see `poller.js`'s `request()` for the contract `app.js` relies on.
  /// Unlike `PollingWs` (which issues its own dedicated `status()` call
  /// right after, so correlation to its own response is exact), this
  /// resolves off the shared push stream: the oldest still-pending
  /// `request()` claims the next app-level message that arrives. Exact
  /// as long as at most one request is in flight at a time, which is the
  /// contract `app.js`'s own `inFlight` guard (and any game code sharing
  /// this `ws`) already relies on. Rejects on a genuine transport
  /// failure (the `ws_message` call itself throwing), same as
  /// `PollingWs.request()`.
  request(sid, req) {
    if (this._closed) return Promise.reject(new Error("GatewayWs: closed"));
    this._sid = sid;
    const record = this._protocol.buildAppMessage(this._transport.clientKey, sid, req);
    return new Promise((resolve, reject) => {
      this._transport.send(record).then(
        () => this._pending.push({ resolve, reject }),
        (e) => reject(e),
      );
    });
  }

  /// True once closed (see `close()`) — a way to check without needing
  /// to have caught the `close` event at the moment it fired.
  get closed() {
    return this._closed;
  }

  close() {
    if (this._closed) return;
    this._transport.close(); // best-effort cooperative goodbye
    this._teardown();
  }

  _teardown() {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._pollTimer);
    if (typeof document !== "undefined" && this._onHide) {
      document.removeEventListener("visibilitychange", this._onHide);
      if (typeof removeEventListener === "function") {
        removeEventListener("pagehide", this._onHide);
      }
    }
    // Reject anything still waiting rather than leaving it hanging.
    for (const p of this._pending.splice(0)) {
      p.reject(new Error("GatewayWs: closed"));
    }
    if (this.onclose) this.onclose();
    this.dispatchEvent(new Event("close"));
  }

  _deliver(data) {
    if (this._closed) return;
    if (this.onmessage) this.onmessage({ data });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  _markAlive() {
    this._erroredSinceSuccess = false;
  }

  // Fires onerror at most once per bad streak — a connection actively
  // failing fast (not just hanging) would otherwise spam it on every
  // tick; same dedupe poller.js's own _reportError does.
  _reportError(e) {
    if (this._erroredSinceSuccess) return;
    this._erroredSinceSuccess = true;
    if (this.onerror) this.onerror({ error: e });
    this.dispatchEvent(new Event("error"));
  }
}
