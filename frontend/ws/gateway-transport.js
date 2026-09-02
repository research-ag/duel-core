// Moves bytes for the embedded-gateway client — and ONLY that. Nothing
// in this file decides what a message MEANS (that's
// `gateway-protocol.js`) or owns the poll loop / reconnect policy /
// public WebSocket-shaped surface (that's `gateway-client.js`). This
// split exists so a future transport that speaks to a REAL external
// Gateway relay (the way `ic-websocket-cdk` is normally deployed — see
// `../../backend/src/Ws.mo`'s doc header) can be dropped in later
// without touching protocol or client code: it would just need to
// implement the same four methods (`open`/`poll`/`send`/`close`) and
// hand `poll()`'s caller the same decoded-envelope shape.
//
// What THIS transport actually does: no external relay process at all.
// `ic-websocket-cdk` doesn't require a pre-registered Gateway principal
// — `ws_open` lets a caller register ITSELF as its own gateway (see
// `ic-websocket-cdk-mo`'s `State.mo`: `REGISTERED_GATEWAYS` is populated
// dynamically from whatever `gateway_principal` a client's own `ws_open`
// call supplies) — so this browser tab calls `ws_open`/`ws_get_messages`/
// `ws_message`/`ws_close` on the canister directly, polling itself the
// way a real Gateway would poll on a client's behalf.
//
// `ws_get_messages` returns each message's `content` as a CBOR-encoded
// `WebsocketMessage` envelope (the CDK certifies the CBOR bytes, not a
// Candid record — see `ic-websocket-cdk-mo`'s `Types.mo`,
// `encode_websocket_message`) — decoding that framing is this
// transport's job; `gateway-protocol.js` never sees CBOR, only the
// decoded `{clientKey, sequenceNum, timestamp, isServiceMessage,
// content}` shape every message boils down to regardless of which
// transport produced it.
//
// Certificate verification (`cert`/`tree` in `ws_get_messages`' result)
// is deliberately NOT performed — the CDK certifies its queue so a
// client can trust a GATEWAY's relay without trusting the Gateway
// itself; since our "gateway" here is the player's own tab (already as
// trusted as the plain `status()` query already implicitly is), that
// property buys nothing and would cost a real BLS-verification
// dependency to check. Documented trade-off, not an oversight — see
// `../README.md`'s "Real-time push" section.

import { decode as cborDecode } from "cborg";
import { Principal } from "@dfinity/principal";

/// CBOR maps decode to plain JS objects (`useMaps: false`) so the rest
/// of this file never has to special-case `Map` — the fixed shape
/// `encode_websocket_message` produces is only ever string-keyed, at
/// most two levels deep (`client_key` nests one more map inside).
const CBOR_OPTS = { useMaps: false };

/// `CanisterOutputMessage.key`'s trailing `_{20-digit nonce}` — see
/// `ic-websocket-cdk-mo`'s `State.mo`'s `format_message_for_gateway_key`.
const NONCE_SUFFIX = /_(\d+)$/;

function decodeEnvelope(contentBytes) {
  const raw = cborDecode(contentBytes, CBOR_OPTS);
  return {
    clientKey: {
      client_principal: Principal.fromUint8Array(
        new Uint8Array(raw.client_key.client_principal),
      ),
      client_nonce: BigInt(raw.client_key.client_nonce),
    },
    sequenceNum: BigInt(raw.sequence_num),
    timestamp: BigInt(raw.timestamp),
    isServiceMessage: Boolean(raw.is_service_message),
    content: new Uint8Array(raw.content),
  };
}

/// One instance per connection attempt — `principal`'s tab registers as
/// its own `gateway_principal` on `open()`, then `poll()` walks its own
/// outgoing queue exactly as a real Gateway's polling loop would.
export class SelfGatewayTransport {
  constructor({ actor, principal }) {
    this._actor = actor;
    this._principal = principal;
    this._nonce = 0n;
    this._clientKey = null; // set by open()
  }

  get clientKey() {
    return this._clientKey;
  }

  /// False right after construction or after `invalidate()` — the
  /// caller (`gateway-client.js`) uses this to decide whether a tick
  /// needs to redo the `ws_open` handshake before polling.
  get isOpen() {
    return this._clientKey !== null;
  }

  /// Drops this transport's registration WITHOUT calling `ws_close` —
  /// for when the caller already knows (or must assume) the canister
  /// side is gone (a failed poll/send after a previously successful
  /// open — presumptively an upgrade wiped `Ws.mo`'s transient state;
  /// see `Host.mo`'s own comment on that) and just needs to force the
  /// next `open()` to redo the handshake from scratch.
  invalidate() {
    // TEMPORARY diagnostic — remove once the "Expected incoming sequence
    // number" bug is root-caused.
    console.debug("[duel-ws] invalidate() clientKey nonce was=%s", this._clientKey?.client_nonce);
    this._clientKey = null;
  }

  async open(clientNonce) {
    // TEMPORARY diagnostic — remove once the "Expected incoming sequence
    // number" bug is root-caused. See gateway-protocol.js's matching log.
    console.debug("[duel-ws] ws_open start nonce=%s", clientNonce);
    // `this._clientKey` (and so `isOpen`) must NOT be set until `ws_open`
    // has actually SUCCEEDED — it used to be set right here, synchronously,
    // before the `await` below even started the real network call. That
    // made `isOpen` true the instant an open merely BEGAN, not once it
    // actually finished: a second caller's `_ensureOpen()` (gateway-
    // client.js), racing in during that window, saw "already open", skipped
    // the `_opening` coalescing entirely, and built+sent a message with
    // whatever `_nextOutgoingSeq` currently held — BEFORE this open's own
    // `resetSequence()` (also in gateway-client.js) had run. Once this
    // open's `ws_open` call finally resolved and reset the counter back to
    // 1, the ORIGINAL caller then sent ITS message, also stamped 1 — a real
    // duplicate sequence number, rejected by the canister as
    // `IncomingSequenceNumberWrong`. Confirmed live: `_tick()`'s own
    // `_ensureOpen()` and a game's own connect-time `request()` (e.g.
    // `lobby-connection.service.ts`'s `init()`) both fire within
    // milliseconds of a fresh page load, reliably landing in this window
    // on the very FIRST connection — no reload or second player needed.
    // Deliberately NOT resetting `this._nonce` here. The CDK's outgoing
    // queue is keyed by `gateway_principal` (see `ic-websocket-cdk-mo`'s
    // `State.mo`: `get_gateway_messages_queue`/`push_message_in_gateway_
    // queue`/`get_outgoing_message_nonce`, all keyed only by that) — NOT
    // by `client_key`. Since our `gateway_principal` is this tab's own
    // stable principal, unchanged across a reconnect, the queue itself
    // persists across one too; resetting the poll cursor back to 0 on
    // every `open()` made a reconnect re-walk it from the start,
    // re-delivering already-processed `#view` pushes — stale board
    // states rendered again (briefly, in a fast burst — see
    // gateway-client.js's `isEndOfQueue`-driven catch-up) before
    // snapping back to the real current one. A REAL regression this
    // caused: cars animating backwards then teleporting to the correct
    // position after a reconnect — see `examples/racing/CLAUDE.md`'s
    // "cars occasionally animated backwards" history for the full story,
    // including a DIFFERENT bug with the identical symptom (concurrent
    // fetches racing each other, not a queue replay) fixed earlier by a
    // sequence-number guard on the old plain-polling transport, before it
    // was removed in favor of this WS-only design. `_nonce` only ever
    // starts at 0 once, in the constructor, and then only ever advances
    // (see `poll()`), reconnect or not.
    const res = await this._actor.ws_open({
      client_nonce: clientNonce,
      gateway_principal: this._principal,
    });
    if ("Err" in res) {
      console.debug("[duel-ws] ws_open FAILED nonce=%s err=%s", clientNonce, res.Err);
      throw new Error(`ws_open: ${res.Err}`);
    }
    // Only NOW does this transport count as open — see this method's own
    // doc above for why that used to happen too early.
    this._clientKey = {
      client_principal: this._principal,
      client_nonce: clientNonce,
    };
    console.debug("[duel-ws] ws_open OK nonce=%s", clientNonce);
  }

  /// Returns `{envelopes, isEndOfQueue}` — the batch waiting since the
  /// last poll, advancing this transport's own nonce past whatever it
  /// just read. That nonce is purely local bookkeeping a real-Gateway-
  /// backed transport wouldn't need at all (a relay pushes messages as
  /// they arrive; there is no "nonce" to track client-side), which is
  /// exactly why it lives here and not in `gateway-protocol.js`.
  async poll() {
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
    // TEMPORARY diagnostic — remove once the "other seat's push never
    // arrives" bug is root-caused.
    if (messages.length) {
      console.debug("[duel-ws] poll got %d msg(s), nonce now=%s, eoq=%s", messages.length, this._nonce, is_end_of_queue);
    }
    return {
      envelopes: messages.map((m) => decodeEnvelope(m.content)),
      isEndOfQueue: is_end_of_queue,
    };
  }

  /// `record` is an already-built `WebsocketMessage` Candid record (see
  /// `gateway-protocol.js`'s `buildAppMessage`/`buildKeepAliveReply`) —
  /// this transport only ever transmits it, never builds or interprets
  /// its `content`. `ws_message`'s second parameter (`opt blob`, see
  /// `../idl.js`'s doc on it) is decorative on the canister side — the
  /// CDK ignores its value — but we pack `record.content`'s own bytes
  /// into it anyway rather than sending `[]`: it costs nothing (the same
  /// bytes are already sitting right here) and means `from_candid` on
  /// the backend can recover the original `Ws.Msg` from it directly,
  /// without a live canister to poll `content` off of.
  async send(record) {
    const res = await this._actor.ws_message({ msg: record }, [record.content]);
    if ("Err" in res) throw new Error(`ws_message: ${res.Err}`);
  }

  async close() {
    if (!this._clientKey) return;
    // Best-effort: a teardown call racing an already-dead connection
    // (network gone, tab closing) failing silently is fine — the CDK's
    // own keep-alive timeout is the backstop either way (see
    // `../../backend/src/Ws.mo`'s doc header).
    try {
      await this._actor.ws_close({ client_key: this._clientKey });
    } catch {
      // already gone; nothing to do
    }
  }
}
