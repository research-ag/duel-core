import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Principal } from "@icp-sdk/core/principal";
import { GatewayWs } from "../../src/ws/gateway-client.js";
import { FakeCanister, sampleGameTypes } from "../support/fake-canister.js";
import type { View, WsPayload } from "../../src/types.js";

const principal = Principal.anonymous();

/// Polls `pred` every few ms until it returns true, or fails the test
/// after `timeoutMs`. GatewayWs drives itself off real timers (see its
/// own header — `intervalMs`), so tests use a short interval and a
/// generous-but-bounded wait rather than mocking time.
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/// Builds a GatewayWs wired to `canister` and registers `t.after()` to
/// close it — UNCONDITIONALLY, even if the test throws/fails partway
/// through. GatewayWs's poll loop runs on real (refed) timers, so a
/// test that asserts-and-returns without ever calling close() leaves it
/// running forever and the whole `node --test` process hangs waiting for
/// the event loop to drain — a real failure mode hit while writing these
/// tests, not a hypothetical one.
function makeWs(
  t: TestContext,
  canister: FakeCanister,
  extra: Partial<{ intervalMs: number; requestTimeoutMs: number }> = {},
): GatewayWs {
  const ws = new GatewayWs({
    actor: canister,
    principal,
    gameIdlTypes: sampleGameTypes,
    intervalMs: 10,
    requestTimeoutMs: 200,
    ...extra,
  });
  t.after(() => ws.close());
  return ws;
}

test("constructor requires actor/principal/gameIdlTypes", () => {
  assert.throws(
    () => new GatewayWs({ actor: undefined as never, principal, gameIdlTypes: sampleGameTypes }),
    /`actor` is required/,
  );
  assert.throws(
    () => new GatewayWs({ actor: new FakeCanister(), principal: undefined as never, gameIdlTypes: sampleGameTypes }),
    /`principal` is required/,
  );
  assert.throws(
    () => new GatewayWs({ actor: new FakeCanister(), principal, gameIdlTypes: undefined as never }),
    /`gameIdlTypes` is required/,
  );
});

test("onopen fires exactly once once the poll loop observes the CDK's OpenMessage", async (t) => {
  const canister = new FakeCanister();
  const ws = makeWs(t, canister);
  let opens = 0;
  ws.onopen = () => opens++;
  await waitFor(() => opens >= 1);
  await new Promise((r) => setTimeout(r, 50)); // give a few more ticks a chance to (wrongly) refire
  assert.equal(opens, 1);
});

test("send(): sid reaches the canister, and the push it triggers arrives via onmessage", async (t) => {
  const canister = new FakeCanister();
  canister.respond = () => ({ view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } });
  const ws = makeWs(t, canister);
  const received: WsPayload[] = [];
  ws.onmessage = (ev) => received.push(ev.data);
  await waitFor(() => canister.opened);

  ws.send({ req: { sid: "player-1", req: { status: null } } });
  await waitFor(() => canister.sentRequests.length >= 1);
  assert.deepEqual(canister.sentRequests[0], { status: null });

  await waitFor(() => received.some((p) => "view" in p && "lobby" in p.view));
});

test("request(): resolves with its own correlated reply, unaffected by an interleaved broadcast", async (t) => {
  const canister = new FakeCanister();
  const lobbyView: View = { lobby: { p1Open: false, p2Open: true, resetAvailable: false } };
  canister.respond = () => ({ view: lobbyView });
  const ws = makeWs(t, canister);
  await waitFor(() => canister.opened);

  // A genuine unsolicited broadcast (reqId: null) lands on this same
  // connection before the correlated reply — must be delivered
  // generically (onmessage) but must NOT resolve the pending request().
  const broadcastView: View = { endedByOther: null };
  const genericMessages: WsPayload[] = [];
  ws.onmessage = (ev) => genericMessages.push(ev.data);
  canister.pushUnsolicited(broadcastView);

  const result = await ws.request!("player-2", { status: null });
  assert.deepEqual(result, { view: lobbyView });
  assert.ok(
    genericMessages.some((p) => "view" in p && "endedByOther" in p.view),
    "the broadcast must still have been delivered generically",
  );
});

test("request(): rejects on timeout when no reply ever arrives", async (t) => {
  const canister = new FakeCanister();
  // respond() throwing means ws_message still returns Ok (the canister
  // "processed" the call) but never enqueues a reply — simulates a
  // request that genuinely never got answered.
  canister.respond = () => {
    throw new Error("no reply, on purpose");
  };
  const ws = makeWs(t, canister, { requestTimeoutMs: 30 });
  await assert.rejects(() => ws.request!("player-1", { status: null }), /timed out/);
});

test("close(): rejects every pending request and fires onclose", async (t) => {
  const canister = new FakeCanister();
  canister.respond = () => {
    throw new Error("never replies");
  };
  const ws = makeWs(t, canister, { requestTimeoutMs: 60_000 });
  let closed = false;
  ws.onclose = () => (closed = true);
  const pending = ws.request!("player-1", { status: null });
  await waitFor(() => canister.sentRequests.length >= 1);
  ws.close();
  await assert.rejects(() => pending, /GatewayWs: closed/);
  assert.equal(closed, true);
  assert.equal(ws.closed, true);
});

test("send()/request() are no-ops/rejections once closed", async (t) => {
  const canister = new FakeCanister();
  const ws = makeWs(t, canister);
  ws.close();
  assert.doesNotThrow(() => ws.send({ req: { sid: "x", req: { status: null } } }));
  await assert.rejects(() => ws.request!("x", { status: null }), /closed/);
});

test("onerror does not fire after a single failed tick, only once a second consecutive one lands", async (t) => {
  const canister = new FakeCanister();
  canister.wsOpenBehavior = "err";
  const ws = makeWs(t, canister, { intervalMs: 30 });
  let errors = 0;
  ws.onerror = () => errors++;

  // Right after the very first tick has had time to fail once (but not
  // twice), onerror must still be silent — see _reportError()'s own doc
  // for why a lone blip shouldn't surface as a connection error.
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(errors, 0, "a single failed tick must not report onerror yet");

  // Once a second consecutive failure has had time to land, it must.
  await waitFor(() => errors >= 1, 1000);
  assert.equal(errors, 1);
});

test("onerror fires again after recovering and then failing anew", async (t) => {
  const canister = new FakeCanister();
  canister.wsOpenBehavior = "err";
  const ws = makeWs(t, canister, { intervalMs: 10 });
  let errors = 0;
  ws.onerror = () => errors++;
  await waitFor(() => errors >= 1);

  canister.wsOpenBehavior = "ok";
  await waitFor(() => canister.opened);
  // Let one successful poll land so _markAlive() actually resets the
  // failure streak before breaking things again.
  await new Promise((r) => setTimeout(r, 20));

  // Break the already-open connection's polling instead of ws_open
  // again (a mid-session canister hiccup, not a failed handshake) —
  // each failed poll invalidates the transport, so the next tick redoes
  // the (still-succeeding) handshake before polling fails again.
  canister.wsGetMessagesBehavior = "err";
  // A fresh bad streak needs its own two consecutive failures before
  // reporting again — _erroredSinceSuccess resets on the recovery above.
  await waitFor(() => errors >= 2, 1000);
});
