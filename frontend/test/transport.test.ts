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
import type { Status, TransportPayload } from "../src/types.js";

const SID = "an:test";

const live: DuelTransport[] = [];
afterEach(() => {
  for (const transport of live.splice(0)) transport.close();
});

function connect(
  canister: FakeCanister,
  keepAliveMs = 60000,
  pollTimeoutMs = 3000
): DuelTransport {
  const transport = connectTransport({
    actor: canister,
    gameIdlTypes: sampleGameTypes,
    intervalMs: 5,
    keepAliveMs,
    pollTimeoutMs,
  });
  live.push(transport);
  return transport;
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
  const transport = connect(canister);
  let opens = 0;
  const seen: TransportPayload[] = [];
  transport.onopen = () => opens++;
  transport.onmessage = (ev) => seen.push(ev.data);
  transport.send({ req: { sid: SID, req: { status: null } } });
  await until(() => seen.length === 1, "the first view");
  assert.equal(opens, 1);
  assert.deepEqual(seen[0], { view: ENDED });
  assert.deepEqual(canister.sent, [], "a status is a query, not an update call");
  transport.close();
});

test("request() resolves with the view its ack promised", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  canister.respond = (req) =>
    "rematch" in req ? { view: inGame(7n) } : { view: ENDED };
  const reply = await transport.request(SID, { rematch: null });
  assert.deepEqual(reply, { view: inGame(7n) });
  transport.close();
});

test("an engine error comes back as the reply, not a rejection", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  canister.respond = () => ({ err: { notSeated: null } });
  assert.deepEqual(await transport.request(SID, { rematch: null }), {
    err: { notSeated: null },
  });
  transport.close();
});

test("a change made by the other seat arrives by polling", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  const seen: TransportPayload[] = [];
  transport.onmessage = (ev) => seen.push(ev.data);
  await transport.request(SID, { status: null });
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the polled view");
  assert.deepEqual(seen[1], { view: BROWSING });
  const polls = canister.polls;
  await until(() => canister.polls > polls + 3, "more polls");
  assert.equal(seen.length, 2, "an unchanged revision delivers nothing");
  transport.close();
});

test("requests go out one at a time, in order", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  const a = transport.request(SID, { rematch: null });
  const b = transport.request(SID, { ackEnded: null });
  await Promise.all([a, b]);
  assert.deepEqual(canister.sent, [{ rematch: null }, { ackEnded: null }]);
  transport.close();
});

test("a thrown update call is resent", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  canister.failRequests = 1;
  assert.deepEqual(await transport.request(SID, { rematch: null }), { view: ENDED });
  assert.equal(canister.attempts, 2);
  assert.equal(canister.sent.length, 1);
  transport.close();
});

test("a resend rejected as #stale settles with a fresh status instead", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  canister.failRequests = 1;
  canister.landsBeforeFailing = true;
  let calls = 0;
  canister.respond = () => (calls++ === 0 ? { view: BROWSING } : { err: { stale: null } });
  assert.deepEqual(await transport.request(SID, { leave: { gen: 1n } }), {
    view: BROWSING,
  });
  // The resync after the #stale resend is a query: not in `sent`.
  assert.deepEqual(canister.sent, [{ leave: { gen: 1n } }, { leave: { gen: 1n } }]);
  transport.close();
});

test("an update call that keeps failing rejects after its resends", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await transport.request(SID, { status: null }); // follow table 1
  canister.failRequests = 3;
  await assert.rejects(transport.request(SID, { rematch: null }), /network down/);
  assert.equal(canister.attempts, 3);
  transport.close();
});

test("a table that is gone sends the transport back to the lobby", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  const seen: TransportPayload[] = [];
  transport.onmessage = (ev) => seen.push(ev.data);
  await transport.request(SID, { status: null });
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the lobby");
  assert.deepEqual(seen[1], { view: BROWSING });
  transport.close();
});

test("a table request with no table followed is #notSeated, never sent", async () => {
  const canister = new FakeCanister();
  canister.current = BROWSING;
  const transport = connect(canister);
  await transport.request(SID, { status: null });
  assert.deepEqual(await transport.request(SID, { rematch: null }), { err: { notSeated: null } });
  assert.deepEqual(canister.sent, []);
  transport.close();
});

test("two failed polls in a row presume the link lost, then it recovers", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  let connecting = 0;
  let opens = 0;
  transport.onconnecting = () => connecting++;
  transport.onopen = () => opens++;
  await transport.request(SID, { status: null });
  canister.pollBehavior = "err";
  await until(() => connecting === 1, "onconnecting");
  canister.pollBehavior = "ok";
  await until(() => opens === 2, "the relink");
  transport.close();
});

test("a poll that never answers is abandoned and the next one delivers", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 60000, 30);
  const seen: TransportPayload[] = [];
  let connecting = 0;
  transport.onmessage = (ev) => seen.push(ev.data);
  transport.onconnecting = () => connecting++;
  await transport.request(SID, { status: null });
  canister.pollBehavior = "hang";
  const polls = canister.polls;
  await until(() => canister.polls > polls, "the hanging poll");
  canister.pollBehavior = "ok";
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the polled view");
  assert.deepEqual(seen[1], { view: BROWSING });
  assert.equal(connecting, 0, "a lone stall does not drop the link");
  transport.close();
});

test("polls that keep hanging presume the link lost, then it recovers", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 60000, 20);
  let connecting = 0;
  let opens = 0;
  transport.onconnecting = () => connecting++;
  transport.onopen = () => opens++;
  await transport.request(SID, { status: null });
  canister.pollBehavior = "hang";
  await until(() => connecting === 1, "onconnecting");
  canister.pollBehavior = "ok";
  await until(() => opens === 2, "the relink");
  transport.close();
});

test("a poll answering after its timeout still delivers, without a relink", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 60000, 30);
  const seen: TransportPayload[] = [];
  let connecting = 0;
  transport.onmessage = (ev) => seen.push(ev.data);
  transport.onconnecting = () => connecting++;
  await transport.request(SID, { status: null });
  canister.pollDelayMs = 45;
  canister.push(BROWSING);
  await until(() => seen.length === 2, "the late view");
  assert.deepEqual(seen[1], { view: BROWSING });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(connecting, 0, "a slow link is not a lost one");
  transport.close();
});

test("hanging polls stop piling up at the limit", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 60000, 10);
  await transport.request(SID, { status: null });
  const polls = canister.polls;
  canister.pollBehavior = "hang";
  // Ticks, relink attempts included, keep waiting on the newest of at
  // most three unanswered polls instead of asking again.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(canister.polls - polls, 3);
  transport.close();
});

test("a poll that throws synchronously is an ordinary failure", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 60000, 20);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  let connecting = 0;
  let opens = 0;
  transport.onconnecting = () => connecting++;
  transport.onopen = () => opens++;
  await transport.request(SID, { status: null });
  canister.pollBehavior = "throw";
  await until(() => connecting === 1, "onconnecting");
  canister.pollBehavior = "ok";
  await until(() => opens === 2, "the relink");
  await new Promise((r) => setTimeout(r, 60));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  transport.close();
});

test("a client waiting at its table keeps it alive, and only then", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister, 20);
  await transport.request(SID, { status: null }); // ENDED: not waiting
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(canister.keepAlives, 0);
  canister.push({
    atTable: {
      id: 1n,
      view: { stagingYou: { seat: { p1: null }, reservedForPartner: false, gen: 1n, visibility: { open: null } } },
    },
  } as Status);
  await until(() => canister.keepAlives >= 2, "keep-alives while waiting");
  transport.close();
});

test("concurrent status sends are coalesced", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  const seen: TransportPayload[] = [];
  transport.onmessage = (ev) => seen.push(ev.data);
  transport.send({ req: { sid: SID, req: { status: null } } });
  transport.send({ req: { sid: SID, req: { status: null } } });
  await until(() => seen.length >= 1, "the view");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 1, "one resync, one delivery");
  transport.close();
});

test("close() sends nothing and rejects later requests", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  let closes = 0;
  transport.onclose = () => closes++;
  await transport.request(SID, { status: null });
  transport.close();
  const polls = canister.polls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(canister.polls, polls, "no more polls once closed");
  assert.equal(canister.sent.length, 0);
  assert.equal(closes, 1);
  await assert.rejects(transport.request(SID, { status: null }), /closed/);
});

test("a request the IDL cannot encode rejects without reaching the canister", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  await assert.rejects(transport.request(SID, { bogus: null } as never));
  assert.equal(canister.sent.length, 0);
  transport.close();
});

test("queryStatus() composes the status from queries alone", async () => {
  const canister = new FakeCanister();
  const transport = connect(canister);
  assert.deepEqual(await transport.queryStatus(SID), ENDED);
  transport.close();
});
