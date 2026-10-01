import { test } from "node:test";
import assert from "node:assert/strict";
import { Principal } from "@icp-sdk/core/principal";
import { SelfGatewayTransport, type WsActor } from "../../src/ws/gateway-transport.js";
import { GatewayProtocol } from "../../src/ws/gateway-protocol.js";

function sampleGameTypes({ IDL: I }: { IDL: any }) {
  return { Action: I.Variant({ pass: I.Null }), State: I.Record({ hp: I.Nat }) };
}

const principal = Principal.anonymous();

/// A minimal in-memory fake of the four ws_* canister methods, enough to
/// drive SelfGatewayTransport's own logic without a real IC agent.
function makeFakeActor(overrides: Partial<WsActor> = {}): WsActor {
  return {
    ws_open: async () => ({ Ok: null }),
    ws_close: async () => ({ Ok: null }),
    ws_message: async () => ({ Ok: null }),
    ws_get_messages: async () => ({ Ok: { messages: [], is_end_of_queue: true } }),
    ...overrides,
  } as WsActor;
}

test("isOpen/clientKey: false/null before open(), true/set after", async () => {
  const t = new SelfGatewayTransport({ actor: makeFakeActor(), principal });
  assert.equal(t.isOpen, false);
  assert.equal(t.clientKey, null);
  await t.open(123n);
  assert.equal(t.isOpen, true);
  assert.deepEqual(t.clientKey, { client_principal: principal, client_nonce: 123n });
});

test("open() passes an initial message as ws_open's second argument, or [] without one", async () => {
  const seen: Array<[Uint8Array] | []> = [];
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({
      ws_open: async (_args, initial) => {
        seen.push(initial);
        return { Ok: null };
      },
    }),
    principal,
  });
  await t.open(1n);
  t.invalidate();
  const initial = new Uint8Array([4, 5, 6]);
  await t.open(2n, initial);
  assert.deepEqual(seen, [[], [initial]]);
});

test("open() throws and stays closed when ws_open returns Err", async () => {
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_open: async () => ({ Err: "nope" }) }),
    principal,
  });
  await assert.rejects(() => t.open(1n), /ws_open: nope/);
  assert.equal(t.isOpen, false);
});

test("invalidate() clears clientKey/isOpen without calling ws_close", async () => {
  let closeCalled = false;
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_close: async () => { closeCalled = true; return { Ok: null }; } }),
    principal,
  });
  await t.open(1n);
  t.invalidate();
  assert.equal(t.isOpen, false);
  assert.equal(closeCalled, false);
});

test("close() calls ws_close with the current clientKey, then no-ops once clientKey is null", async () => {
  let seenKey: unknown;
  let closeCalls = 0;
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({
      ws_close: async (args) => { seenKey = args.client_key; closeCalls++; return { Ok: null }; },
    }),
    principal,
  });
  await t.open(9n);
  await t.close();
  assert.deepEqual(seenKey, { client_principal: principal, client_nonce: 9n });
  assert.equal(closeCalls, 1);
  // isOpen/clientKey must go false/null right away — not stay stale
  // until some later reopen — and a second close() must see that and
  // skip sending a redundant ws_close for a registration already said
  // goodbye to.
  assert.equal(t.isOpen, false);
  assert.equal(t.clientKey, null);
  await t.close();
  assert.equal(closeCalls, 1);
});

test("close() before any open() is a silent no-op", async () => {
  let called = false;
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_close: async () => { called = true; return { Ok: null }; } }),
    principal,
  });
  await t.close();
  assert.equal(called, false);
});

test("close() swallows a failing ws_close (best-effort goodbye)", async () => {
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_close: async () => { throw new Error("network gone"); } }),
    principal,
  });
  await t.open(1n);
  await assert.doesNotReject(() => t.close());
});

test("send() rejects with the canister's Err text on failure", async () => {
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_message: async () => ({ Err: "sequence mismatch" }) }),
    principal,
  });
  const protocol = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const record = protocol.buildAppMessage(null, "sid", { status: null }, null);
  await assert.rejects(() => t.send(record), /ws_message: sequence mismatch/);
});

test("poll() decodes each message's CBOR envelope and advances past the highest key nonce", async () => {
  const protocol = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  // A real, decodable envelope, so poll()'s own decodeEnvelope (CBOR)
  // round-trips correctly, keyed with the CDK's own "..._{nonce}" suffix
  // convention (see gateway-transport.ts's NONCE_SUFFIX).
  const { encode: cborEncode } = await import("cborg");
  const built = protocol.buildAppMessage(
    { client_principal: principal, client_nonce: 1n },
    "sid",
    { status: null },
    null,
  );
  const content = cborEncode({
    client_key: { client_principal: principal.toUint8Array(), client_nonce: built.client_key!.client_nonce },
    sequence_num: built.sequence_num,
    timestamp: built.timestamp,
    is_service_message: built.is_service_message,
    content: built.content,
  });

  const t = new SelfGatewayTransport({
    actor: makeFakeActor({
      ws_get_messages: async ({ nonce }) => {
        assert.equal(nonce, 0n); // first poll starts at the transport's own initial nonce
        return {
          Ok: {
            messages: [{ key: "gateway_key_0000000000000000042", content: new Uint8Array(content) }],
            is_end_of_queue: false,
          },
        };
      },
    }),
    principal,
  });
  await t.open(1n);

  const { envelopes, isEndOfQueue } = await t.poll();
  assert.equal(envelopes.length, 1);
  assert.equal(isEndOfQueue, false);
  assert.equal(envelopes[0]!.sequenceNum, built.sequence_num);
  assert.deepEqual(envelopes[0]!.content, built.content);

  // The next poll should start past the just-observed nonce (42 + 1).
  const t2Actor = makeFakeActor({
    ws_get_messages: async ({ nonce }) => {
      assert.equal(nonce, 0n);
      return {
        Ok: {
          messages: [{ key: "gateway_key_0000000000000000042", content: new Uint8Array(content) }],
          is_end_of_queue: true,
        },
      };
    },
  });
  const t2 = new SelfGatewayTransport({ actor: t2Actor, principal });
  await t2.open(1n);
  await t2.poll();
  let secondPollNonce: bigint | null = null;
  t2Actor.ws_get_messages = async ({ nonce }) => {
    secondPollNonce = nonce;
    return { Ok: { messages: [], is_end_of_queue: true } };
  };
  await t2.poll();
  assert.equal(secondPollNonce, 43n);
});

async function envelopeFor(clientNonce: bigint): Promise<Uint8Array> {
  const { encode: cborEncode } = await import("cborg");
  const protocol = new GatewayProtocol({ gameIdlTypes: sampleGameTypes });
  const built = protocol.buildAppMessage({ client_principal: principal, client_nonce: clientNonce }, "sid", { status: null }, null);
  return new Uint8Array(
    cborEncode({
      client_key: { client_principal: principal.toUint8Array(), client_nonce: clientNonce },
      sequence_num: built.sequence_num,
      timestamp: built.timestamp,
      is_service_message: false,
      content: built.content,
    }),
  );
}

test("poll() drops envelopes addressed to another connection (an earlier page load's leftovers) but reads past them", async () => {
  const mine = await envelopeFor(2n);
  const theirs = await envelopeFor(1n);
  const actor = makeFakeActor({
    ws_get_messages: async () => ({
      Ok: {
        messages: [
          { key: "gw_00000000000000000000", content: theirs },
          { key: "gw_00000000000000000001", content: mine },
        ],
        is_end_of_queue: true,
      },
    }),
  });
  const t = new SelfGatewayTransport({ actor, principal });
  await t.open(2n);
  const { envelopes } = await t.poll();
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]!.clientKey.client_nonce, 2n);
  let next: bigint | null = null;
  actor.ws_get_messages = async ({ nonce }) => {
    next = nonce;
    return { Ok: { messages: [], is_end_of_queue: true } };
  };
  await t.poll();
  assert.equal(next, 2n);
});

test("open() restarts the read position at 0: the canister's counter restarts with a re-created gateway", async () => {
  const content = await envelopeFor(1n);
  const seen: bigint[] = [];
  const actor = makeFakeActor({
    ws_get_messages: async ({ nonce }) => {
      seen.push(nonce);
      return { Ok: { messages: [{ key: "gw_00000000000000000041", content }], is_end_of_queue: true } };
    },
  });
  const t = new SelfGatewayTransport({ actor, principal });
  await t.open(1n);
  await t.poll();
  await t.open(3n);
  await t.poll();
  assert.deepEqual(seen, [0n, 0n]);
});

test("poll() throws the canister's Err text on failure", async () => {
  const t = new SelfGatewayTransport({
    actor: makeFakeActor({ ws_get_messages: async () => ({ Err: "boom" }) }),
    principal,
  });
  await assert.rejects(() => t.poll(), /ws_get_messages: boom/);
});
