import { test } from "node:test";
import assert from "node:assert/strict";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { GatewayProtocol } from "../../src/ws/gateway-protocol.js";
import { buildEngineTypes } from "../../src/idl.js";

function sampleGameTypes({ IDL: I }: { IDL: typeof IDL }) {
  return {
    Action: I.Variant({ pass: I.Null }),
    State: I.Record({ hp: I.Nat }),
  };
}

const clientKey = {
  client_principal: Principal.anonymous(),
  client_nonce: 7n,
};

test("buildAppMessage: sequence number starts at 1 and increments per call", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const m1 = p.buildAppMessage(clientKey, "sid-1", { status: null }, null);
  const m2 = p.buildAppMessage(clientKey, "sid-1", { status: null }, null);
  assert.equal(m1.sequence_num, 1n);
  assert.equal(m2.sequence_num, 2n);
  assert.equal(m1.is_service_message, false);
});

test("resetSequence brings the counter back to 1 (post-reconnect)", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  p.buildAppMessage(clientKey, "sid-1", { status: null }, null);
  p.buildAppMessage(clientKey, "sid-1", { status: null }, null);
  p.resetSequence();
  const m = p.buildAppMessage(clientKey, "sid-1", { status: null }, null);
  assert.equal(m.sequence_num, 1n);
});

test("buildKeepAliveReply is marked is_service_message and carries the reflected sequence number", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const reply = p.buildKeepAliveReply(clientKey, 42n);
  assert.equal(reply.is_service_message, true);
  const { WebsocketServiceMessageContent } = buildEngineTypes({ IDL, ...sampleGameTypes({ IDL }) });
  const decoded = IDL.decode([WebsocketServiceMessageContent], reply.content)[0] as {
    KeepAliveMessage: { last_incoming_sequence_num: bigint };
  };
  assert.equal(decoded.KeepAliveMessage.last_incoming_sequence_num, 42n);
});

test("interpret: a #req frame (a client->canister request, never a reply to anything) decodes to 'unknown'", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const msg = p.buildAppMessage(clientKey, "sid-1", { submit: { pass: null } }, 5n);
  // interpret() takes a *decoded* envelope — plug the built record's
  // content straight in, the same shape gateway-transport.js's
  // decodeEnvelope() would hand back.
  const action = p.interpret({
    clientKey,
    sequenceNum: msg.sequence_num,
    timestamp: msg.timestamp,
    isServiceMessage: false,
    content: msg.content,
  });
  assert.equal(action.kind, "unknown"); // a #req frame — never a reply to anything; see interpret()'s own doc
});

test("interpret: a #view push round-trips with its reqId", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const { Action, State } = sampleGameTypes({ IDL });
  const types = (p as unknown as { _types: { WsMsg: IDL.Type } })._types;
  const view = { lobby: { p1Open: true, p2Open: false, resetAvailable: false } };
  const content = IDL.encode([types.WsMsg], [{ view: { reqId: [3n], view } }]);
  const action = p.interpret({
    clientKey,
    sequenceNum: 1n,
    timestamp: 0n,
    isServiceMessage: false,
    content: content instanceof Uint8Array ? content : new Uint8Array(content),
  });
  assert.deepEqual(action, { kind: "message", payload: { view }, reqId: 3n });
  void Action;
  void State;
});

test("interpret: a #view push with no reqId decodes reqId as null (unsolicited broadcast)", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const types = (p as unknown as { _types: { WsMsg: IDL.Type } })._types;
  const view = { endedByOther: null };
  const content = IDL.encode([types.WsMsg], [{ view: { reqId: [], view } }]);
  const action = p.interpret({
    clientKey,
    sequenceNum: 1n,
    timestamp: 0n,
    isServiceMessage: false,
    content: content instanceof Uint8Array ? content : new Uint8Array(content),
  });
  assert.deepEqual(action, { kind: "message", payload: { view }, reqId: null });
});

test("interpret: an #err push round-trips", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const types = (p as unknown as { _types: { WsMsg: IDL.Type } })._types;
  const err = { illegalMove: "no" };
  const content = IDL.encode([types.WsMsg], [{ err: { reqId: [9n], err } }]);
  const action = p.interpret({
    clientKey,
    sequenceNum: 1n,
    timestamp: 0n,
    isServiceMessage: false,
    content: content instanceof Uint8Array ? content : new Uint8Array(content),
  });
  assert.deepEqual(action, { kind: "message", payload: { err }, reqId: 9n });
});

test("interpret: service messages — OpenMessage/AckMessage/CloseMessage", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const types = (p as unknown as { _types: { WebsocketServiceMessageContent: IDL.Type } })._types;

  const openBytes = IDL.encode(
    [types.WebsocketServiceMessageContent],
    [{ OpenMessage: { client_key: clientKey } }],
  );
  assert.deepEqual(
    p.interpret({
      clientKey,
      sequenceNum: 1n,
      timestamp: 0n,
      isServiceMessage: true,
      content: openBytes instanceof Uint8Array ? openBytes : new Uint8Array(openBytes),
    }),
    { kind: "open" },
  );

  const ackBytes = IDL.encode(
    [types.WebsocketServiceMessageContent],
    [{ AckMessage: { last_incoming_sequence_num: 11n } }],
  );
  assert.deepEqual(
    p.interpret({
      clientKey,
      sequenceNum: 1n,
      timestamp: 0n,
      isServiceMessage: true,
      content: ackBytes instanceof Uint8Array ? ackBytes : new Uint8Array(ackBytes),
    }),
    { kind: "ack", lastIncomingSequenceNum: 11n },
  );

  const closeBytes = IDL.encode(
    [types.WebsocketServiceMessageContent],
    [{ CloseMessage: { reason: { KeepAliveTimeout: null } } }],
  );
  assert.deepEqual(
    p.interpret({
      clientKey,
      sequenceNum: 1n,
      timestamp: 0n,
      isServiceMessage: true,
      content: closeBytes instanceof Uint8Array ? closeBytes : new Uint8Array(closeBytes),
    }),
    { kind: "close", reason: "KeepAliveTimeout" },
  );
});

test("interpret: garbage content never throws, folds to 'unknown'", () => {
  const p = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const action = p.interpret({
    clientKey,
    sequenceNum: 1n,
    timestamp: 0n,
    isServiceMessage: false,
    content: new Uint8Array([1, 2, 3, 4]),
  });
  assert.deepEqual(action, { kind: "unknown" });
});
