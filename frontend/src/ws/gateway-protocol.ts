// Pure WS-protocol logic: Candid encode/decode of the content blob,
// outgoing sequence-number bookkeeping, and interpreting a decoded
// envelope. No network. Encodes against the exact types `../idl.ts`
// declares, so the two sides can't drift. The CDK's first client message
// carries `sequence_num = 1`.

import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, type BuildGameTypes, type EngineTypes } from "../idl.js";
import type { EngineErr, Status, WsRequest } from "../types.js";

export interface ClientKey {
  client_principal: unknown;
  client_nonce: bigint;
}

/// The outer `WebsocketMessage` record a transport transmits.
export interface WebsocketMessageRecord {
  client_key: ClientKey | null;
  sequence_num: bigint;
  timestamp: bigint;
  is_service_message: boolean;
  content: Uint8Array;
}

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

export class GatewayProtocol {
  private _types: EngineTypes;
  private _nextOutgoingSeq: bigint;

  constructor({ gameIdlTypes }: { gameIdlTypes: BuildGameTypes }) {
    const { Action, State } = gameIdlTypes({ IDL });
    this._types = buildEngineTypes({ IDL, Action, State });
    this._nextOutgoingSeq = 1n;
  }

  /// Call alongside every reopen: a fresh `client_key` restarts the CDK's
  /// expected sequence at 1.
  resetSequence(): void {
    this._nextOutgoingSeq = 1n;
  }

  // `IDL.encode` returns an ArrayBuffer or a Uint8Array depending on the
  // `@icp-sdk/core` version.
  private _encode(type: IDL.Type, value: unknown): Uint8Array {
    const buf = IDL.encode([type], [value]);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  private _decode<T>(type: IDL.Type, bytes: Uint8Array): T {
    return IDL.decode([type], bytes)[0] as T;
  }

  /// The bare encoded request — what `ws_open` carries as its initial
  /// message, and what `buildAppMessage` wraps in an envelope. `reqId`
  /// (or `null` for fire-and-forget) is echoed back on this request's
  /// own reply.
  encodeAppMessage(sid: string, req: WsRequest, reqId: bigint | null): Uint8Array {
    return this._encode(this._types.WsMsg, {
      req: { sid, req, reqId: reqId == null ? [] : [reqId] },
    });
  }

  buildAppMessage(
    clientKey: ClientKey | null,
    sid: string,
    req: WsRequest,
    reqId: bigint | null,
  ): WebsocketMessageRecord {
    return this._envelope(clientKey, this.encodeAppMessage(sid, req, reqId), false);
  }

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
    console.debug(
      "[duel-ws] send seq=%s svc=%s nonce=%s",
      sequence_num,
      isServiceMessage,
      clientKey?.client_nonce,
    );
    return {
      client_key: clientKey,
      sequence_num,
      timestamp: BigInt(Date.now()) * 1_000_000n, // ns, matching Time.now()
      is_service_message: isServiceMessage,
      content,
    };
  }

  /// Never throws: a decode failure folds into `{kind: "unknown"}`.
  /// `reqId` is `null` for an unsolicited broadcast.
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
        return { kind: "unknown" };
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
      return { kind: "unknown" };
    } catch {
      return { kind: "unknown" };
    }
  }
}
