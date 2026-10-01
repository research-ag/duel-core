// Moves bytes for the embedded-gateway client, nothing more. The CDK
// doesn't require a pre-registered Gateway principal — `ws_open` lets a
// caller register itself — so this tab calls `ws_open`/`ws_get_messages`/
// `ws_message`/`ws_close` directly, polling as a real Gateway would. A
// real-Gateway transport implements the same four methods and hands back
// the same decoded-envelope shape.
//
// `ws_get_messages` returns each `content` as a CBOR-encoded
// `WebsocketMessage`; decoding that framing is this file's job.
// Certificate verification (`cert`/`tree`) is deliberately skipped: the
// "gateway" is the player's own tab, so it buys nothing and would cost a
// BLS dependency.

import { decode as cborDecode } from "cborg";
import { Principal } from "@icp-sdk/core/principal";
import type { DecodedEnvelope, WebsocketMessageRecord } from "./gateway-protocol.js";
import type { Status } from "../types.js";

const CBOR_OPTS = { useMaps: false };

/// `CanisterOutputMessage.key`'s trailing `_{nonce}`.
const NONCE_SUFFIX = /_(\d+)$/;

export interface TransportClientKey {
  client_principal: Principal;
  client_nonce: bigint;
}

interface RawEnvelope {
  client_key: { client_principal: ArrayLike<number>; client_nonce: unknown };
  sequence_num: unknown;
  timestamp: unknown;
  is_service_message: unknown;
  content: ArrayLike<number>;
}

function decodeEnvelope(contentBytes: Uint8Array): DecodedEnvelope {
  const raw = cborDecode(contentBytes, CBOR_OPTS) as RawEnvelope;
  return {
    clientKey: {
      client_principal: Principal.fromUint8Array(
        new Uint8Array(raw.client_key.client_principal),
      ),
      client_nonce: BigInt(raw.client_key.client_nonce as never),
    },
    sequenceNum: BigInt(raw.sequence_num as never),
    timestamp: BigInt(raw.timestamp as never),
    isServiceMessage: Boolean(raw.is_service_message),
    content: new Uint8Array(raw.content),
  };
}

/// The four `ws_*` methods `mo:duel-game-core/actor_mixin` supplies.
export interface WsActor {
  ws_open(
    args: { client_nonce: bigint; gateway_principal: Principal },
    initial: [Uint8Array] | [],
  ): Promise<{ Ok: null } | { Err: string }>;
  ws_close(args: {
    client_key: TransportClientKey;
  }): Promise<{ Ok: null } | { Err: string }>;
  ws_message(
    args: { msg: WebsocketMessageRecord },
    msgType: [Uint8Array] | [],
  ): Promise<{ Ok: null } | { Err: string }>;
  /// The host's plain `status` query, when the actor declares it.
  status?(sid: string): Promise<Status>;
  ws_get_messages(args: { nonce: bigint }): Promise<
    | {
        Ok: {
          messages: Array<{ key: string; content: Uint8Array }>;
          is_end_of_queue: boolean;
        };
      }
    | { Err: string }
  >;
}

export class SelfGatewayTransport {
  private _actor: WsActor;
  private _principal: Principal;
  private _nonce: bigint;
  private _clientKey: TransportClientKey | null;

  constructor({ actor, principal }: { actor: WsActor; principal: Principal }) {
    this._actor = actor;
    this._principal = principal;
    this._nonce = 0n;
    this._clientKey = null;
  }

  get clientKey(): TransportClientKey | null {
    return this._clientKey;
  }

  get isOpen(): boolean {
    return this._clientKey !== null;
  }

  /// Drops the registration WITHOUT `ws_close`, forcing the next `open()`
  /// to redo the handshake.
  invalidate(): void {
    console.debug("[duel-ws] invalidate() clientKey nonce was=%s", this._clientKey?.client_nonce);
    this._clientKey = null;
  }

  /// `initial`, when given, is an already-encoded app message (the
  /// `content` of a `WebsocketMessageRecord`, no envelope) the canister
  /// handles inside the same `ws_open` call.
  async open(clientNonce: bigint, initial: Uint8Array | null = null): Promise<void> {
    console.debug("[duel-ws] ws_open start nonce=%s initial=%s", clientNonce, initial != null);
    // `_clientKey` is set only after `ws_open` SUCCEEDS: setting it
    // earlier lets a racing `_ensureOpen()` skip coalescing and send with
    // a sequence number this open's `resetSequence()` then reuses —
    // rejected as a wrong sequence number.
    //
    // `_nonce` restarts at 0: the CDK's outgoing counter restarts whenever
    // it re-creates this gateway (an upgrade, an expired eviction), and a
    // kept nonce would skip everything it sends from then on. What a reset
    // replays from a surviving queue belongs to earlier connections, which
    // `poll()` drops by `client_key`.
    const res = await this._actor.ws_open(
      { client_nonce: clientNonce, gateway_principal: this._principal },
      initial == null ? [] : [initial],
    );
    if ("Err" in res) {
      console.debug("[duel-ws] ws_open FAILED nonce=%s err=%s", clientNonce, res.Err);
      throw new Error(`ws_open: ${res.Err}`);
    }
    this._clientKey = {
      client_principal: this._principal,
      client_nonce: clientNonce,
    };
    this._nonce = 0n;
    console.debug("[duel-ws] ws_open OK nonce=%s", clientNonce);
  }

  /// The batch waiting since the last poll, advancing the local nonce.
  /// Only the current connection's envelopes: the queue is per gateway
  /// (this tab's stable principal), so it also holds what an earlier page
  /// load or connection left behind.
  async poll(): Promise<{ envelopes: DecodedEnvelope[]; isEndOfQueue: boolean }> {
    const current = this._clientKey?.client_nonce ?? null;
    const res = await this._actor.ws_get_messages({ nonce: this._nonce });
    if ("Err" in res) throw new Error(`ws_get_messages: ${res.Err}`);
    const { messages, is_end_of_queue } = res.Ok;
    let nextNonce = this._nonce;
    for (const m of messages) {
      const match = NONCE_SUFFIX.exec(m.key);
      if (match) {
        const n = BigInt(match[1]) + 1n;
        if (n > nextNonce) nextNonce = n;
      }
    }
    this._nonce = nextNonce;
    if (messages.length) {
      console.debug("[duel-ws] poll got %d msg(s), nonce now=%s, eoq=%s", messages.length, this._nonce, is_end_of_queue);
    }
    return {
      envelopes: messages
        .map((m) => decodeEnvelope(m.content))
        .filter((e) => current !== null && e.clientKey.client_nonce === current),
      isEndOfQueue: is_end_of_queue,
    };
  }

  /// `ws_message`'s second parameter is decorative on the canister side;
  /// the same bytes are packed in so `from_candid` could recover them.
  async send(record: WebsocketMessageRecord): Promise<void> {
    const res = await this._actor.ws_message({ msg: record }, [record.content]);
    if ("Err" in res) throw new Error(`ws_message: ${res.Err}`);
  }

  async close(): Promise<void> {
    if (!this._clientKey) return;
    const clientKey = this._clientKey;
    // Cleared synchronously so a concurrent close() no-ops.
    this._clientKey = null;
    try {
      await this._actor.ws_close({ client_key: clientKey });
    } catch {
      // already gone
    }
  }
}
