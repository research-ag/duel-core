// Pure WS-protocol business logic: Candid encode/decode of the message
// content blob, outgoing sequence-number bookkeeping, and interpreting a
// decoded envelope into an action the caller should take. Nothing in this
// file makes a network call or knows how bytes actually reach the
// canister — that's `gateway-transport.js`'s job. This split is
// deliberate: a transport that speaks to a REAL external Gateway relay
// instead of self-registering (see `gateway-transport.js`'s own header)
// can be dropped in later without touching a single line here, as long
// as it keeps handing this module the same decoded-envelope shape.
//
// `WebsocketMessage`'s `content` field is itself an opaque `Blob` as far
// as the canister's OWN Candid interface is concerned (`ic-websocket-cdk`
// only ever writes/reads it via Motoko's `to_candid`/`from_candid` — see
// `../idl.js`'s `buildEngineTypes` doc header) — everything below is
// this package's own from-scratch implementation of that same encoding,
// using `@icp-sdk/core/candid`'s `IDL.encode`/`IDL.decode` against the
// EXACT type descriptions `../idl.js` already declares for the
// canister's service, so the two sides can't drift apart.
//
// The CDK's own sequencing rule (`ic-websocket-cdk-mo`'s `Constants.mo`,
// `INITIAL_CLIENT_SEQUENCE_NUM = 1`): a client's outgoing sequence number
// is incremented BEFORE each send, so the first message a client ever
// sends carries `sequence_num = 1`, not `0`.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type BuildGameTypes, type EngineTypes } from "../idl.js";
import type { EngineErr, Status, WsRequest } from "../types.js";

export interface ClientKey {
  client_principal: unknown;
  client_nonce: bigint;
}

/// The outer `WebsocketMessage` Candid record — what a transport's
/// `send()` actually transmits; see `gateway-transport.js`.
export interface WebsocketMessageRecord {
  client_key: ClientKey | null;
  sequence_num: bigint;
  timestamp: bigint;
  is_service_message: boolean;
  content: Uint8Array;
}

/// A decoded incoming envelope — see `gateway-transport.js`'s `poll()`.
export interface DecodedEnvelope {
  clientKey: ClientKey;
  sequenceNum: bigint;
  timestamp: bigint;
  isServiceMessage: boolean;
  content: Uint8Array;
}

export type ProtocolAction =
  | { kind: "open" }
  | { kind: "ack"; lastIncomingSequenceNum: bigint }
  | { kind: "close"; reason: string }
  | {
      kind: "message";
      payload: { view: Status } | { err: EngineErr };
      reqId: bigint | null;
    }
  | { kind: "unknown" };

/// Builds the encode/decode/interpret surface for one game's message
/// shape. `gameIdlTypes` is the SAME `buildGameTypes` function passed to
/// `makeIdlFactory` elsewhere (see `../idl.js`) — it supplies `Action`/
/// `State`, the only two types the engine doesn't already fix.
export class GatewayProtocol {
  private _types: EngineTypes;
  private _nextOutgoingSeq: bigint;

  constructor({ gameIdlTypes }: { gameIdlTypes: BuildGameTypes }) {
    const { Action, State } = gameIdlTypes({ IDL });
    this._types = buildEngineTypes({ IDL, Action, State });
    this._nextOutgoingSeq = 1n;
  }

  /// A fresh `ws_open` (a brand new `client_key`, since the client_nonce
  /// changes every reconnect) starts the CDK's own expected-sequence
  /// bookkeeping over at 1 for that new identity — this must be called
  /// alongside every reopen or the canister rejects our first message
  /// post-reconnect as a sequence mismatch.
  resetSequence(): void {
    this._nextOutgoingSeq = 1n;
  }

  /// Candid-encodes `value` against `type`, returning a `Uint8Array` —
  /// `IDL.encode` hands back an `ArrayBuffer` in some `@icp-sdk/core`
  /// versions, a `Uint8Array` in others; normalize once here so nothing
  /// downstream has to care which.
  private _encode(type: IDL.Type, value: unknown): Uint8Array {
    const buf = IDL.encode([type], [value]);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  private _decode<T>(type: IDL.Type, bytes: Uint8Array): T {
    return IDL.decode([type], bytes)[0] as T;
  }

  /// Builds the outer `WebsocketMessage` record for an application
  /// request (`{join: ...}`, `{submit: ...}`, ...) bound for `sid` —
  /// ready to hand to a transport's `send()`. `reqId` (a BigInt, or
  /// `null` for a fire-and-forget caller with nothing to correlate) is
  /// echoed back verbatim on this request's own `#view`/`#err` reply —
  /// see `../idl.js`'s `WsMsg` doc for why that round-trip exists.
  buildAppMessage(
    clientKey: ClientKey | null,
    sid: string,
    req: WsRequest,
    reqId: bigint | null,
  ): WebsocketMessageRecord {
    const content = this._encode(this._types.WsMsg, {
      req: { sid, req, reqId: reqId == null ? [] : [reqId] },
    });
    return this._envelope(clientKey, content, false);
  }

  /// Builds the outer `WebsocketMessage` record for the CDK's own
  /// keep-alive reply — sent in response to every `#AckMessage` the
  /// canister's periodic timer pushes (see `../../backend/src/Ws.mo`'s
  /// doc header on the resulting disappearance-detection floor).
  buildKeepAliveReply(
    clientKey: ClientKey | null,
    lastIncomingSequenceNum: bigint,
  ): WebsocketMessageRecord {
    const content = this._encode(this._types.WebsocketServiceMessageContent, {
      KeepAliveMessage: { last_incoming_sequence_num: lastIncomingSequenceNum },
    });
    return this._envelope(clientKey, content, true);
  }

  private _envelope(
    clientKey: ClientKey | null,
    content: Uint8Array,
    isServiceMessage: boolean,
  ): WebsocketMessageRecord {
    const sequence_num = this._nextOutgoingSeq;
    this._nextOutgoingSeq += 1n;
    // TEMPORARY diagnostic — remove once the "Expected incoming sequence
    // number" bug is root-caused. Logs every outgoing envelope's identity
    // so a live repro's console shows exactly which client_key/nonce and
    // sequence_num was actually sent, in order.
    console.debug(
      "[duel-ws] send seq=%s svc=%s nonce=%s",
      sequence_num,
      isServiceMessage,
      clientKey?.client_nonce,
    );
    return {
      client_key: clientKey,
      sequence_num,
      timestamp: BigInt(Date.now()) * 1_000_000n, // ns, matching Time.now()'s unit
      is_service_message: isServiceMessage,
      content,
    };
  }

  /// Interprets one decoded envelope (see `gateway-transport.js`'s
  /// `poll()` — CBOR-decoding the outer `WebsocketMessage` frame is
  /// THAT module's job; this only ever sees the result) into a tagged
  /// action for `gateway-client.js` to react to:
  ///
  ///   {kind: "open"}                                  — CDK's own hello
  ///   {kind: "ack", lastIncomingSequenceNum}           — reply with a keep-alive
  ///   {kind: "close", reason}                          — canister evicted us
  ///   {kind: "message", payload: {view: V} | {err: E}, reqId} — an
  ///     app-level push; `reqId` (a BigInt, or `null`) is `Ws.mo`'s
  ///     echoed-back correlation token — `null` means this is an
  ///     unsolicited broadcast (the OTHER seat acted), not a reply to
  ///     anything THIS connection asked for — see `gateway-client.js`'s
  ///     `_pending` doc for why that distinction matters.
  ///   {kind: "unknown"}                                — malformed/unexpected; drop it
  ///
  /// Never throws: a decode failure is exactly as actionable as any
  /// other unrecognized frame, so it folds into `{kind: "unknown"}`
  /// rather than needing its own try/catch at every call site.
  interpret(envelope: DecodedEnvelope): ProtocolAction {
    try {
      if (envelope.isServiceMessage) {
        const svc = this._decode<Record<string, unknown>>(
          this._types.WebsocketServiceMessageContent,
          envelope.content,
        );
        if ("OpenMessage" in svc) return { kind: "open" };
        if ("AckMessage" in svc) {
          return {
            kind: "ack",
            lastIncomingSequenceNum: (
              svc.AckMessage as { last_incoming_sequence_num: bigint }
            ).last_incoming_sequence_num,
          };
        }
        if ("CloseMessage" in svc) {
          const reason = (svc.CloseMessage as { reason: object }).reason;
          return { kind: "close", reason: Object.keys(reason)[0] };
        }
        return { kind: "unknown" }; // KeepAliveMessage: canister never sends this
      }
      const msg = this._decode<Record<string, unknown>>(
        this._types.WsMsg,
        envelope.content,
      );
      if ("view" in msg) {
        const v = msg.view as { reqId: [bigint] | []; view: Status };
        const reqId = v.reqId.length ? v.reqId[0] : null;
        return { kind: "message", payload: { view: v.view }, reqId };
      }
      if ("err" in msg) {
        const e = msg.err as { reqId: [bigint] | []; err: EngineErr };
        const reqId = e.reqId.length ? e.reqId[0] : null;
        return { kind: "message", payload: { err: e.err }, reqId };
      }
      return { kind: "unknown" }; // a stray #req echoed back — nothing to do with it
    } catch {
      return { kind: "unknown" };
    }
  }
}
