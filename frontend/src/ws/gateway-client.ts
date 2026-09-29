// The public, WebSocket-shaped surface `../ws.ts`'s `connectWs()` returns
// — the only transport this package ships. Owns the poll loop, the
// open/reconnect policy, and request/response correlation; delegates
// bytes to gateway-transport.ts and message meaning to
// gateway-protocol.ts, so a real-Gateway transport can swap in underneath.
// Exposes `onopen`/`onmessage`/`onerror`/`onclose`/`send(msg)` plus
// `request(sid, req)`, a Promise of this call's own `{view}`/`{err}`
// correlated by `reqId` (this connection also carries unsolicited pushes
// from the other seat acting).

import type { Principal } from "@icp-sdk/core/principal";
import { SelfGatewayTransport, type WsActor } from "./gateway-transport.js";
import { GatewayProtocol } from "./gateway-protocol.js";
import type { BuildGameTypes } from "../idl.js";
import type { DuelWs, WsPayload, WsRequest } from "../types.js";

const DEFAULT_INTERVAL_MS = 500;

/// Backstop for a request that never reached the canister at all.
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
  private _opened: boolean;
  private _pollTimer: ReturnType<typeof setTimeout> | null;
  private _ticking: boolean; // re-entrancy guard for _tick()
  private _wantsAnotherTick: boolean;
  // In-flight request()s keyed by reqId — never a FIFO, since a
  // `#view`/`#err` here is routinely a broadcast rather than a reply.
  private _pending: Map<bigint, PendingRequest>;
  private _nextReqId: bigint; // matches the wire's Nat64
  // Messages that never got a confirmed transmission, resent on the next
  // confirmed open — see _queueResend().
  private _resendQueue: Array<{ sid: string; req: WsRequest; reqId: bigint | null }>;
  private _erroredSinceSuccess: boolean;
  private _consecutiveFailures: number;
  private _opening: Promise<void> | null; // in-flight _ensureOpen()
  private _sendChain: Promise<void>; // serializes every outgoing ws_message
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

    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    // Next tick, so a caller assigning handlers after construction is
    // ready before anything fires.
    setTimeout(() => this._tick(), 0);

    // Cooperative goodbye on `pagehide` only — NOT `visibilitychange`,
    // which fires on plain backgrounding and would abort a live game.
    if (typeof addEventListener === "function") {
      this._onHide = () => this._transport.close();
      addEventListener("pagehide", this._onHide);
    }
  }

  /// The one loop: reopen if needed, poll, react, reschedule. ANY failure
  /// invalidates the registration so the next tick redoes `ws_open`.
  private async _tick(): Promise<void> {
    // A second overlapping tick would deliver views out of order.
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
      fast = !isEndOfQueue;
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

  /// Coalesces concurrent callers onto one in-flight `ws_open`. A
  /// `send()`/`request()` before the first tick would otherwise build a
  /// message with a null `client_key`.
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

  /// Serializes every outgoing send: the CDK evicts a client on an
  /// out-of-order sequence number, and two in-flight update calls (a
  /// keep-alive reply and a user send) have no ordering guarantee. A
  /// failed send doesn't break the chain for what follows.
  private _serialSend(record: Parameters<SelfGatewayTransport["send"]>[0]): Promise<void> {
    const result = this._sendChain.then(() => this._transport.send(record));
    this._sendChain = result.catch(() => {});
    return result;
  }

  /// A failed `ws_message` presumptively means the canister forgot this
  /// registration (upgrade, keep-alive eviction); redo `ws_open` now
  /// rather than wait up to the CDK's own timeout.
  private _invalidateAndRetry(): void {
    this._transport.invalidate();
    this._pollSoon();
  }

  /// A message whose send failed never reached `ws.mo`, so no reply is
  /// coming; resend it after the next confirmed open. Safe: every
  /// mutation is gated by the engine's own legality/idempotency checks.
  private _queueResend(sid: string, req: WsRequest, reqId: bigint | null): void {
    this._resendQueue.push({ sid, req, reqId });
  }

  /// `buildAppMessage` throws on a request its IDL doesn't recognize (a
  /// tampered `data-act`); never let that become an unhandled rejection.
  private _tryBuildMessage(sid: string, req: WsRequest, reqId: bigint | null): { record: ReturnType<GatewayProtocol["buildAppMessage"]> } | { error: Error } {
    try {
      return { record: this._protocol.buildAppMessage(this._transport.clientKey, sid, req, reqId) };
    } catch (e) {
      return { error: e as Error };
    }
  }

  private _flushResendQueue(): void {
    if (this._closed || !this._resendQueue.length) return;
    const queued = this._resendQueue;
    this._resendQueue = [];
    for (const { sid, req, reqId } of queued) {
      const built = this._tryBuildMessage(sid, req, reqId);
      if ("error" in built) {
        console.debug("[duel-ws] resend could not be re-encoded, dropping it:", built.error.message);
        continue;
      }
      this._serialSend(built.record).then(
        () => this._pollSoon(),
        (e) => {
          console.debug("[duel-ws] resend after reconnect failed, will retry on the next one:", e && e.message ? e.message : e);
          this._queueResend(sid, req, reqId);
          this._invalidateAndRetry();
        },
      );
    }
  }

  /// `#alreadySubmitted`/`#stale` on a resent mutation can only mean the
  /// original already landed; every other error is ambiguous.
  private _isRetryAmbiguousError(payload: WsPayload): boolean {
    return "err" in payload && ("alreadySubmitted" in payload.err || "stale" in payload.err);
  }

  /// Settle the caller with a fresh `#status` instead of an error that
  /// would make a successful click look failed.
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

  /// Poll right away: by the time `ws_message` resolves, `ws.mo` has
  /// already queued the resulting view.
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
    // Temporary diagnostic logging.
    console.debug("[duel-ws] handle kind=%s reqId=%s", action.kind, "reqId" in action ? action.reqId : undefined);
    switch (action.kind) {
      case "open": {
        // Fires on EVERY confirmed (re)open — `onopen` is the caller's
        // only hook to resync after a gap.
        this._opened = true;
        if (this.onopen) this.onopen();
        this.dispatchEvent(new Event("open"));
        this._flushResendQueue();
        break;
      }
      case "ack": {
        // The keep-alive reply the canister's disappearance detection
        // watches for.
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
        this._teardown();
        break;
      }
      case "message": {
        // Deliver generically first, then resolve a matching pending
        // request by reqId (`null` = an unsolicited broadcast).
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

  /// Fire-and-forget: the result only ever surfaces as a `message`/`error`
  /// event. Safe before the connection is open.
  send(msg: { req?: { sid: string; req: WsRequest } }): void {
    if (this._closed) return;
    const envelope = msg?.req;
    if (!envelope) return;
    const { sid, req } = envelope;
    this._sid = sid;
    this._ensureOpen().then(
      () => {
        const built = this._tryBuildMessage(sid, req, null);
        if ("error" in built) {
          this._reportError(built.error);
          return;
        }
        this._serialSend(built.record).then(
          () => this._pollSoon(),
          (e) => {
            this._reportError(e);
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

  /// Resolves with THIS call's own `{view}`/`{err}`, matched by reqId, so
  /// any number of requests can be in flight. Does NOT reject just because
  /// the `ws_message` call throws client-side: the reply is usually
  /// already queued server-side and still arrives; the timeout is the
  /// backstop. The pending entry is registered BEFORE sending, since the
  /// poll loop can observe the reply before the update call resolves.
  request(sid: string, req: WsRequest): Promise<WsPayload> {
    if (this._closed) return Promise.reject(new Error("GatewayWs: closed"));
    this._sid = sid;
    const reqId = this._nextReqId++;
    return new Promise<WsPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(reqId)) {
          reject(new Error("GatewayWs: request timed out waiting for a reply"));
        }
      }, this._requestTimeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });

      this._ensureOpen().then(
        () => {
          const built = this._tryBuildMessage(sid, req, reqId);
          if ("error" in built) {
            clearTimeout(timer);
            this._pending.delete(reqId);
            reject(built.error);
            return;
          }
          this._serialSend(built.record).then(
            () => this._pollSoon(),
            (e) => {
              // Keep the pending entry; queue a real resend.
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

  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._transport.close();
    this._teardown();
  }

  private _teardown(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._pollTimer != null) clearTimeout(this._pollTimer);
    if (this._onHide && typeof removeEventListener === "function") {
      removeEventListener("pagehide", this._onHide);
    }
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

  // `onerror` fires only on a second consecutive failure: a lone blip
  // (e.g. the agent's certificate-polling budget on a cold canister)
  // self-heals within a tick and was a real false alarm.
  private _reportError(e: Error): void {
    console.debug("[duel-ws] error:", e && e.message ? e.message : e);
    this._consecutiveFailures++;
    if (this._consecutiveFailures < 2) return;
    if (this._erroredSinceSuccess) return;
    this._erroredSinceSuccess = true;
    if (this.onerror) this.onerror({ error: e });
    this.dispatchEvent(new Event("error"));
  }
}
