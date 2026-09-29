// A tiny in-memory stand-in for a canister wired with `mo:duel-game-core/ws`:
// decodes each `ws_message` app request and enqueues a matching reply
// (echoing `reqId`) for the next poll.

import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { encode as cborEncode } from "cborg";
import { buildEngineTypes, type EngineTypes } from "../../src/idl.js";
import type { WsActor } from "../../src/ws/gateway-transport.js";
import type { WebsocketMessageRecord } from "../../src/ws/gateway-protocol.js";
import type { EngineErr, Status } from "../../src/types.js";

export function sampleGameTypes({ IDL: I }: { IDL: typeof IDL }) {
  return { Action: I.Variant({ pass: I.Null }), State: I.Record({ hp: I.Nat }) };
}

interface RawClientKey {
  client_principal: Principal;
  client_nonce: bigint;
}

export class FakeCanister implements WsActor {
  private types: EngineTypes;
  private outgoing: Array<{ key: string; content: Uint8Array }> = [];
  private nextKeyNonce = 0;
  private lastClientKey: RawClientKey | null = null;

  /// What to reply with for the next decoded app request — defaults to a
  /// harmless `atTable`/`#endedByOther` status. Override per test.
  respond: (req: unknown) => { view: Status } | { err: EngineErr } = () => ({
    view: { atTable: { id: 1n, view: { endedByOther: null } } },
  });
  wsMessageBehavior: "ok" | "err" = "ok";
  wsOpenBehavior: "ok" | "err" = "ok";
  wsGetMessagesBehavior: "ok" | "err" = "ok";
  /// Calls this test has observed to ws_message, in order — lets a test
  /// assert on what was actually sent (e.g. `sid`).
  sentRequests: unknown[] = [];

  constructor() {
    const { Action, State } = sampleGameTypes({ IDL });
    this.types = buildEngineTypes({ IDL, Action, State });
  }

  private _encode(type: IDL.Type, value: unknown): Uint8Array {
    const buf = IDL.encode([type], [value]);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  private _pushRaw(clientKey: RawClientKey, isServiceMessage: boolean, content: Uint8Array): void {
    const raw = cborEncode({
      client_key: {
        client_principal: clientKey.client_principal.toUint8Array(),
        client_nonce: clientKey.client_nonce,
      },
      sequence_num: 0n,
      timestamp: 0n,
      is_service_message: isServiceMessage,
      content,
    });
    const key = `gateway_key_${String(this.nextKeyNonce).padStart(20, "0")}`;
    this.nextKeyNonce += 1;
    this.outgoing.push({ key, content: new Uint8Array(raw) });
  }

  /// Whether `ws_open` has ever succeeded — lets a test wait for the
  /// handshake without reaching into private state.
  get opened(): boolean {
    return this.lastClientKey !== null;
  }

  async ws_open(args: { client_nonce: bigint; gateway_principal: Principal }) {
    if (this.wsOpenBehavior === "err") return { Err: "denied" };
    const clientKey = { client_principal: args.gateway_principal, client_nonce: args.client_nonce };
    this.lastClientKey = clientKey;
    this._pushRaw(
      clientKey,
      true,
      this._encode(this.types.WebsocketServiceMessageContent, {
        OpenMessage: { client_key: clientKey },
      }),
    );
    return { Ok: null };
  }

  async ws_close() {
    return { Ok: null };
  }

  async ws_message(
    args: { msg: WebsocketMessageRecord },
    _msgType?: [Uint8Array] | [],
  ): Promise<{ Ok: null } | { Err: string }> {
    if (this.wsMessageBehavior === "err") return { Err: "rejected" };
    // `WebsocketMessageRecord.client_key` types its principal as `unknown`
    // (gateway-protocol.ts stays agnostic of any particular Principal
    // implementation) — this fake canister always constructs it with a
    // real `Principal`, same as the genuine `SelfGatewayTransport` does.
    const clientKey = (args.msg.client_key as RawClientKey | null) ?? this.lastClientKey;
    const decoded = IDL.decode([this.types.WsMsg], args.msg.content)[0] as {
      req?: { sid: string; req: unknown; reqId: [bigint] | [] };
    };
    if (decoded.req && clientKey) {
      this.sentRequests.push(decoded.req.req);
      const reply = this.respond(decoded.req.req);
      if ("view" in reply) {
        this._pushRaw(
          clientKey,
          false,
          this._encode(this.types.WsMsg, { view: { reqId: decoded.req.reqId, view: reply.view } }),
        );
      } else {
        this._pushRaw(
          clientKey,
          false,
          this._encode(this.types.WsMsg, { err: { reqId: decoded.req.reqId, err: reply.err } }),
        );
      }
    }
    return { Ok: null };
  }

  /// Test-only: enqueue an unsolicited push (reqId omitted, same as `ws.mo`'s
  /// `pushRelevant` broadcasting to the OTHER seat)
  pushUnsolicited(view: Status): void {
    if (!this.lastClientKey) throw new Error("FakeCanister: no client_key yet — call after ws_open");
    this._pushRaw(
      this.lastClientKey,
      false,
      this._encode(this.types.WsMsg, { view: { reqId: [], view } }),
    );
  }

  async ws_get_messages(args: { nonce: bigint }) {
    if (this.wsGetMessagesBehavior === "err") return { Err: "unavailable" };
    const messages = this.outgoing.filter((_m, i) => BigInt(i) >= args.nonce);
    return { Ok: { messages, is_end_of_queue: true } };
  }
}
