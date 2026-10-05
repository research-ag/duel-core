// `DuelTransport` against the in-memory `FakeCanister`.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { connectTransport, type DuelTransport } from "../src/transport.js";
import {
  FakeCanister,
  sampleGameTypes,
  BROWSING,
  ENDED,
} from "./support/fake-canister.js";
import type { Status, WsPayload } from "../src/types.js";

const SID = "an:test";

const live: DuelTransport[] = [];
afterEach(() => {
  for (const ws of live.splice(0)) ws.close();
});

function connect(
  canister: FakeCanister,
  pingMs = 60000,
  pollTimeoutMs = 3000
): DuelTransport {
  const ws = connectTransport({
    actor: canister,
    gameIdlTypes: sampleGameTypes,
    intervalMs: 5,
    pingMs,
    pollTimeoutMs,
  });
  live.push(ws);
  return ws;
}

async function until(
  cond: () => boolean,
  what: string,
  ms = 3000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const inGame = (hp: bigint): Status =>
  ({
    atTable: {
      id: 1n,
      view: { awaitingRematch: { openSeat: { p1: null }, gen: hp } },
    },
  }) as Status;

test("the first status links: onopen fires once and the view is delivered", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  let opens = 0;
  const seen: WsPayload[] = [];
  ws.onopen = () => opens++;
  ws.onmessage = (ev) => seen.push(ev.data);
  ws.send({ req: { sid: SID, req: { status: null } } });
  await until(() => seen.length === 1, "the first view");
  assert.equal(opens, 1);
  assert.deepEqual(seen[0], { view: ENDED });
  assert.deepEqual(canister.sent, [{ status: null }]);
  ws.close();
});

test("request() resolves with its own reply, straight from the update call", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  canister.respond = (req) =>
    "rematch" in req ? { view: inGame(7n) } : { view: ENDED };
  const reply = await ws.request(SID, { rematch: null });
  assert.deepEqual(reply, { view: inGame(7n) });
  ws.close();
});

test("an engine error comes back as the reply, not a rejection", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  canister.respond = () => ({ err: { notSeated: null } });
  assert.deepEqual(await ws.request(SID, { rematch: null }), {
    err: { notSeated: null },
  });
  ws.close();
});

test("a change made by the other seat arrives by polling", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  const seen: WsPayload[] = [];
  ws.onmessage = (ev) => seen.push(ev.data);
  await ws.request(SID, { status: null });
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the polled view");
  assert.deepEqual(seen[1], { view: BROWSING });
  const polls = canister.polls;
  await until(() => canister.polls > polls + 3, "more polls");
  assert.equal(seen.length, 2, "an unchanged revision delivers nothing");
  ws.close();
});

test("requests go out one at a time, in order", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  const a = ws.request(SID, { rematch: null });
  const b = ws.request(SID, { ackEnded: null });
  await Promise.all([a, b]);
  assert.deepEqual(canister.sent, [{ rematch: null }, { ackEnded: null }]);
  ws.close();
});

test("a thrown update call is resent", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  canister.failRequests = 1;
  assert.deepEqual(await ws.request(SID, { rematch: null }), { view: ENDED });
  assert.equal(canister.attempts, 2);
  assert.equal(canister.sent.length, 1);
  ws.close();
});

test("a resend rejected as #stale settles with a fresh status instead", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  canister.failRequests = 1;
  canister.landsBeforeFailing = true;
  let calls = 0;
  canister.respond = (req) => {
    if ("status" in req) return { view: BROWSING };
    return calls++ === 0 ? { view: BROWSING } : { err: { stale: null } };
  };
  assert.deepEqual(await ws.request(SID, { leave: { gen: 1n } }), {
    view: BROWSING,
  });
  assert.deepEqual(canister.sent, [
    { leave: { gen: 1n } },
    { leave: { gen: 1n } },
    { status: null },
  ]);
  ws.close();
});

test("an update call that keeps failing rejects and fires onerror", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  let errors = 0;
  ws.onerror = () => errors++;
  canister.failRequests = 3;
  await assert.rejects(ws.request(SID, { rematch: null }), /network down/);
  assert.equal(errors, 1);
  ws.close();
});

test("a forgotten link is redone under a new epoch", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  let opens = 0;
  let connecting = 0;
  ws.onopen = () => opens++;
  ws.onconnecting = () => connecting++;
  await ws.request(SID, { status: null });
  canister.forget();
  await until(() => opens === 2, "the relink");
  assert.equal(connecting, 1);
  assert.deepEqual(canister.sent, [{ status: null }, { status: null }]);
  assert.notEqual(canister.requests[0].epoch, canister.requests[1].epoch);
  ws.close();
});

test("two failed polls in a row presume the link lost, then it recovers", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  let connecting = 0;
  let opens = 0;
  ws.onconnecting = () => connecting++;
  ws.onopen = () => opens++;
  await ws.request(SID, { status: null });
  canister.pollBehavior = "err";
  await until(() => connecting === 1, "onconnecting");
  canister.pollBehavior = "ok";
  await until(() => opens === 2, "the relink");
  ws.close();
});

test("a poll that never answers is abandoned and the next one delivers", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister, 60000, 30);
  const seen: WsPayload[] = [];
  let connecting = 0;
  ws.onmessage = (ev) => seen.push(ev.data);
  ws.onconnecting = () => connecting++;
  await ws.request(SID, { status: null });
  canister.pollBehavior = "hang";
  const polls = canister.polls;
  await until(() => canister.polls > polls, "the hanging poll");
  canister.pollBehavior = "ok";
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the polled view");
  assert.deepEqual(seen[1], { view: BROWSING });
  assert.equal(connecting, 0, "a lone stall does not drop the link");
  ws.close();
});

test("polls that keep hanging presume the link lost, then it recovers", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister, 60000, 20);
  let connecting = 0;
  let opens = 0;
  ws.onconnecting = () => connecting++;
  ws.onopen = () => opens++;
  await ws.request(SID, { status: null });
  canister.pollBehavior = "hang";
  await until(() => connecting === 1, "onconnecting");
  canister.pollBehavior = "ok";
  await until(() => opens === 2, "the relink");
  ws.close();
});

test("a quiet link sends a status as its heartbeat", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister, 40);
  await ws.request(SID, { status: null });
  await until(() => canister.sent.length >= 2, "the heartbeat");
  assert.deepEqual(canister.sent[1], { status: null });
  ws.close();
});

test("concurrent status sends are coalesced", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  const seen: WsPayload[] = [];
  ws.onmessage = (ev) => seen.push(ev.data);
  ws.send({ req: { sid: SID, req: { status: null } } });
  ws.send({ req: { sid: SID, req: { status: null } } });
  await until(() => seen.length >= 1, "the view");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(canister.sent.length, 1);
  ws.close();
});

test("close() says goodbye under the current epoch and rejects later requests", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  let closes = 0;
  ws.onclose = () => closes++;
  await ws.request(SID, { status: null });
  ws.close();
  await until(() => canister.sent.length === 2, "the goodbye");
  assert.deepEqual(canister.sent[1], { bye: null });
  assert.equal(canister.requests[1].epoch, canister.requests[0].epoch);
  assert.equal(closes, 1);
  await assert.rejects(ws.request(SID, { status: null }), /closed/);
});

test("a request the IDL cannot encode rejects without reaching the canister", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  await assert.rejects(ws.request(SID, { bogus: null } as never));
  assert.equal(canister.sent.length, 0);
  ws.close();
});

test("queryStatus() goes through the plain status query", async () => {
  const canister = new FakeCanister();
  const ws = connect(canister);
  assert.deepEqual(await ws.queryStatus(SID), ENDED);
  ws.close();
});
