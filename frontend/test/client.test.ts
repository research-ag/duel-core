// The headless client, exercised with no `document`, no `sessionStorage`,
// no HTML: what a game binding its own UI gets.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createDuelClient,
  CONNECTION_CLOSED_MESSAGE,
  claimRoleOf,
  genOf,
  isSeated,
  localSecondsElapsed,
  localSecondsLeft,
  pendingKeyOf,
  turnOf,
  viewOf,
  viewTagOf,
} from "../src/client.js";
import type { ClientState } from "../src/client.js";
import type { DuelWs, InGameView, Status, WsPayload, WsRequest } from "../src/types.js";

interface PendingRequest {
  sid: string;
  req: WsRequest;
  resolve: (p: WsPayload) => void;
  reject: (e: Error) => void;
}

class FakeWs implements DuelWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: WsPayload }) => void) | null = null;
  onerror: ((ev: { error?: Error }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<{ sid: string; req: WsRequest }> = [];
  requests: PendingRequest[] = [];
  request?: (sid: string, req: WsRequest) => Promise<WsPayload>;

  constructor(withRequest = true) {
    if (withRequest) {
      this.request = (sid, req) =>
        new Promise<WsPayload>((resolve, reject) => {
          this.requests.push({ sid, req, resolve, reject });
        });
    }
  }

  send(msg: { req: { sid: string; req: WsRequest } }): void {
    this.sent.push(msg.req);
  }
}

const session = { sid: "an:abc", isLoggedIn: false };

function browsing(): Status {
  return { browsing: { tables: [] } };
}
function staging(gen = 1n): Status {
  return {
    atTable: {
      id: 1n,
      view: {
        stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 30n, gen, visibility: { open: null } },
      },
    },
  };
}
function inGame(over: Partial<InGameView> = {}): Status {
  return {
    atTable: {
      id: 1n,
      view: {
        inGame: {
          seat: { p1: null },
          game: {},
          turn: 3n,
          mode: { simultaneous: null },
          youSubmitted: false,
          oppSubmitted: false,
          gen: 5n,
          secondsUntilIdleReset: 60n,
          idleTimeoutSecs: 60n,
          claimWinAvailable: false,
          secondsUntilClaimable: 20n,
          claimTimeoutSecs: 20n,
          ...over,
        },
      },
    },
  };
}

function record<S>(client: { subscribe(l: (s: ClientState<S>, p: ClientState<S>) => void): () => void }) {
  const states: ClientState<S>[] = [];
  client.subscribe((s) => states.push(s));
  return states;
}

test("createDuelClient(): throws without ws or session; starts connecting with no status", () => {
  assert.throws(() => createDuelClient({ ws: undefined as never, session }), /`ws` is required/);
  assert.throws(() => createDuelClient({ ws: new FakeWs(), session: undefined as never }), /`session` is required/);
  const client = createDuelClient({ ws: new FakeWs(), session });
  assert.deepEqual(client.getState(), {
    connection: "connecting",
    status: null,
    statusAt: 0,
    pending: null,
    error: null,
    authPending: false,
    identityLocked: false,
  });
  assert.equal(client.sid, "an:abc");
});

test("the first #status goes out at construction; onopen marks the connection open and only a reopen asks again", () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  assert.deepEqual(ws.sent, [{ sid: "an:abc", req: { status: null } }]);
  ws.onopen!();
  assert.equal(client.getState().connection, "open");
  assert.equal(ws.sent.length, 1, "the first open must not ask a second time");
  ws.onopen!();
  assert.equal(ws.sent.length, 2, "a reopen after a gap resyncs");
  assert.deepEqual(ws.sent[1], { sid: "an:abc", req: { status: null } });
});

test("a pushed status lands in state with a timestamp; an identical push changes nothing", () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  const states = record(client);
  const before = Date.now();
  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(states.length, 1);
  assert.deepEqual(client.getState().status, browsing());
  assert.ok(client.getState().statusAt >= before);
  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(states.length, 1, "a structurally equal status must not notify");
});

test("a pushed error becomes state.error and clears after errorTtlMs", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ws = new FakeWs();
    const client = createDuelClient({ ws, session, errorTtlMs: 1000 });
    ws.onmessage!({ data: { err: { seatTaken: null } } });
    assert.equal(client.getState().error, "That seat is already taken.");
    mock.timers.tick(999);
    assert.equal(client.getState().error, "That seat is already taken.");
    mock.timers.tick(1);
    assert.equal(client.getState().error, null);
  } finally {
    mock.timers.reset();
  }
});

test("showError/clearError are the UI's own hooks on the same lifetime", () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  client.showError("Enter an access code, or choose Open.");
  assert.equal(client.getState().error, "Enter an access code, or choose Open.");
  client.clearError();
  assert.equal(client.getState().error, null);
});

test("createTable: sets pending with a stable key, resolves ok with the reply's view, then clears pending", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  const states = record(client);
  const p = client.createTable("p1", { open: null }, "classic");
  assert.deepEqual(client.getState().pending, {
    key: "create:p1",
    req: { createTable: { seat: { p1: null }, visibility: { open: null }, variant: "classic" } },
  });
  assert.equal(client.getState().identityLocked, true, "a join in flight locks identity");
  assert.equal(ws.requests.length, 1);
  ws.requests[0]!.resolve({ view: staging() });
  const outcome = await p;
  assert.deepEqual(outcome, { ok: true, view: staging() });
  assert.equal(client.getState().pending, null);
  assert.deepEqual(client.getState().status, staging());
  assert.equal(client.getState().identityLocked, true, "seated now");
  assert.ok(states.length >= 2);
});

test("createTable defaults to an open table with no variant; joinTable wraps the code as a Candid opt", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  void client.createTable("p2");
  assert.deepEqual(ws.requests[0]!.req, { createTable: { seat: { p2: null }, visibility: { open: null }, variant: "" } });
  ws.requests[0]!.resolve({ view: browsing() });
  await Promise.resolve();
  void client.joinTable(4n, "p1", "s3cret");
  assert.deepEqual(ws.requests[1]!.req, { joinTable: { id: 4n, seat: { p1: null }, code: ["s3cret"] } });
  assert.equal(client.getState().pending!.key, "jointable:4:p1");
  ws.requests[1]!.resolve({ view: browsing() });
  await Promise.resolve();
  void client.joinTable(4n, "p2");
  assert.deepEqual(ws.requests[2]!.req, { joinTable: { id: 4n, seat: { p2: null }, code: [] } });
});

test("a second call while one is in flight is refused with reason inFlight", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  void client.rematch();
  const second = await client.leave();
  assert.deepEqual(second, { ok: false, reason: "inFlight" });
  assert.equal(ws.requests.length, 1);
});

test("submit stamps the last-seen gen and turn; leave/reset/claimWin stamp gen", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  ws.onmessage!({ data: { view: inGame() } });
  void client.submit({ pass: null });
  assert.deepEqual(ws.requests[0]!.req, { submit: { gen: 5n, turn: 3n, move: { pass: null } } });
  assert.equal(client.getState().pending!.key, 'act:{"pass":null}');
  ws.requests[0]!.resolve({ view: inGame({ youSubmitted: true }) });
  await Promise.resolve();
  void client.claimWin();
  assert.deepEqual(ws.requests[1]!.req, { claimWin: { gen: 5n } });
  assert.equal(client.getState().pending!.key, "claim-win");
});

test("an engine rejection resolves with reason rejected, its text, and shows it in state.error", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  const p = client.rematch();
  ws.requests[0]!.resolve({ err: { notSeated: null } });
  const outcome = await p;
  assert.deepEqual(outcome, { ok: false, reason: "rejected", err: { notSeated: null }, message: "You are not seated in this game." });
  assert.equal(client.getState().error, "You are not seated in this game.");
  assert.equal(client.getState().pending, null);
});

test("a wrongPhase on create/join is a stale view: silent refresh, no error", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  ws.onmessage!({ data: { view: browsing() } });
  const p = client.createTable("p1");
  ws.requests[0]!.resolve({ err: { wrongPhase: "already seated" } });
  assert.deepEqual(await p, { ok: false, reason: "stale" });
  assert.equal(client.getState().error, null);
  assert.deepEqual(ws.sent.at(-1), { sid: "an:abc", req: { status: null } });
});

test("a #stale on submit/leave/reset/claimWin resyncs the same way; a wrongPhase elsewhere is a real error", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  ws.onmessage!({ data: { view: inGame() } });
  const p = client.submit({ pass: null });
  ws.requests[0]!.resolve({ err: { stale: null } });
  assert.deepEqual(await p, { ok: false, reason: "stale" });
  assert.equal(ws.sent.length, 2, "the initial #status plus one refresh");

  const q = client.rematch();
  ws.requests[1]!.resolve({ err: { wrongPhase: "not in a debrief" } });
  const outcome = await q;
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "rejected");
  assert.equal(client.getState().error, "not in a debrief");
});

test("a transport rejection or a synchronous throw from request() resolves failed and shows the error", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  const p = client.leave();
  ws.requests[0]!.reject(new Error("boom"));
  assert.deepEqual(await p, { ok: false, reason: "failed", message: "Call failed: boom" });
  assert.equal(client.getState().pending, null);

  ws.request = () => {
    throw new Error("sync boom");
  };
  assert.deepEqual(await client.leave(), { ok: false, reason: "failed", message: "Call failed: sync boom" });
  assert.equal(client.getState().error, "Call failed: sync boom");
});

test("fallback transport (no request()): a call goes out via send and settles off the next onmessage", async () => {
  const ws = new FakeWs(false);
  const client = createDuelClient({ ws, session });
  const p = client.rematch();
  assert.deepEqual(ws.sent.at(-1), { sid: "an:abc", req: { rematch: null } });
  assert.equal(client.getState().pending!.key, "rematch");
  ws.onmessage!({ data: { view: staging(2n) } });
  assert.deepEqual(await p, { ok: true, view: staging(2n) });
  assert.equal(client.getState().pending, null);
});

test("fallback transport: a send() throw settles failed immediately", async () => {
  const ws = new FakeWs(false);
  ws.send = () => {
    throw new Error("socket gone");
  };
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  const outcome = await client.rematch();
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "failed");
  assert.equal(client.getState().pending, null);
  assert.equal(client.getState().error, "Send failed: socket gone");
});

test("onclose is terminal: connection closed, a permanent message, identity locked, calls refused, later errors ignored", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  ws.onclose!();
  const s = client.getState();
  assert.equal(s.connection, "closed");
  assert.equal(s.error, CONNECTION_CLOSED_MESSAGE);
  assert.equal(s.identityLocked, true);
  assert.deepEqual(await client.rematch(), { ok: false, reason: "closed" });
  ws.onerror!({ error: new Error("late") });
  assert.equal(client.getState().error, CONNECTION_CLOSED_MESSAGE);
  client.clearError();
  assert.equal(client.getState().error, CONNECTION_CLOSED_MESSAGE);
});

test("onclose settles a fallback call still in flight as closed", async () => {
  const ws = new FakeWs(false);
  const client = createDuelClient({ ws, session });
  const p = client.rematch();
  ws.onclose!();
  assert.deepEqual(await p, { ok: false, reason: "closed" });
});

test("onerror shows a transient error", () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session, errorTtlMs: 0 });
  ws.onerror!({ error: new Error("poll failed") });
  assert.equal(client.getState().error, "WebSocket error: poll failed");
});

test("identityLocked follows the seat: staging/inGame/debrief lock, browsing unlocks, a join in flight keeps it locked through an unrelated browsing push", async () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  ws.onmessage!({ data: { view: staging() } });
  assert.equal(client.getState().identityLocked, true);
  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(client.getState().identityLocked, false);

  const p = client.joinTable(2n, "p2");
  assert.equal(client.getState().identityLocked, true);
  ws.onmessage!({ data: { view: { browsing: { tables: [] } } } });
  assert.equal(client.getState().identityLocked, true, "a rival's push mid-join must not unlock");
  ws.requests[0]!.resolve({ err: { seatTaken: null } });
  await p;
  assert.equal(client.getState().identityLocked, false, "unlocked again after the rejected join");
});

test("login/logout/regenerateSid: authPending locks identity and only a failure releases it, with the error shown", async () => {
  const ws = new FakeWs();
  let loginCalls = 0;
  const client = createDuelClient({
    ws,
    session: {
      sid: "an:abc",
      login: async () => {
        loginCalls++;
        throw new Error("popup closed");
      },
      logout: async () => {},
      regenerate: async () => {},
    },
    errorTtlMs: 0,
  });
  const p = client.login();
  assert.equal(client.getState().authPending, true);
  assert.equal(client.getState().identityLocked, true);
  void client.login();
  assert.equal(loginCalls, 1, "a second click mid-flight is ignored");
  await p;
  assert.equal(client.getState().authPending, false);
  assert.equal(client.getState().identityLocked, false);
  assert.equal(client.getState().error, "Log in failed: popup closed");

  await client.regenerateSid();
  assert.equal(client.getState().authPending, true, "success reloads the page; the lock never releases");
});

test("a session without login/logout/regenerate makes those no-ops", async () => {
  const client = createDuelClient({ ws: new FakeWs(), session: { sid: "an:bare" } });
  await client.login();
  await client.logout();
  await client.regenerateSid();
  assert.equal(client.getState().authPending, false);
});

test("subscribe: listeners get (state, prev) synchronously and can unsubscribe; dispose detaches from ws", () => {
  const ws = new FakeWs();
  const client = createDuelClient({ ws, session });
  const seen: Array<[ClientState, ClientState]> = [];
  const off = client.subscribe((s, p) => seen.push([s, p]));
  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![1].status, null);
  assert.deepEqual(seen[0]![0].status, browsing());
  off();
  ws.onmessage!({ data: { view: staging() } });
  assert.equal(seen.length, 1);
  client.dispose();
  assert.equal(ws.onmessage, null);
  assert.equal(ws.onopen, null);
});

test("selectors: viewTagOf/viewOf/isSeated/genOf/turnOf/claimRoleOf", () => {
  assert.equal(viewTagOf(null), null);
  assert.equal(viewTagOf(browsing()), "browsing");
  assert.equal(viewTagOf(staging()), "stagingYou");
  assert.equal(viewOf(browsing(), "inGame"), null);
  assert.equal(viewOf<InGameView>(inGame(), "inGame")!.turn, 3n);
  assert.equal(isSeated(browsing()), false);
  assert.equal(isSeated(inGame()), true);
  assert.equal(genOf(browsing()), 0n);
  assert.equal(genOf(staging(9n)), 9n);
  assert.equal(turnOf(staging()), 0n);
  assert.equal(turnOf(inGame()), 3n);
  const v = viewOf<InGameView>(inGame(), "inGame")!;
  assert.equal(claimRoleOf(v), null);
  assert.equal(claimRoleOf({ ...v, youSubmitted: true }), "waiting");
  assert.equal(claimRoleOf({ ...v, oppSubmitted: true }), "atRisk");
  assert.equal(claimRoleOf({ ...v, youSubmitted: true, oppSubmitted: true }), null);
});

test("pendingKeyOf mirrors the default UI's button keys, bigint moves included", () => {
  assert.equal(pendingKeyOf({ createTable: { seat: { p2: null }, visibility: { open: null }, variant: "" } }), "create:p2");
  assert.equal(pendingKeyOf({ joinTable: { id: 7n, seat: { p1: null }, code: [] } }), "jointable:7:p1");
  assert.equal(pendingKeyOf({ submit: { gen: 0n, turn: 0n, move: { place: { row: 1, col: 2 } } } }), 'act:{"place":{"row":1,"col":2}}');
  assert.equal(pendingKeyOf({ submit: { gen: 0n, turn: 0n, move: { n: 5n } } }), 'act:{"n":"5"}');
  assert.equal(pendingKeyOf({ ackEnded: null }), "ack");
  assert.equal(pendingKeyOf({ status: null }), "");
});

test("localSecondsLeft/localSecondsElapsed count from statusAt and never go negative", () => {
  assert.equal(localSecondsLeft(30n, 10_000, 10_000), 30n);
  assert.equal(localSecondsLeft(30n, 10_000, 14_999), 26n);
  assert.equal(localSecondsLeft(30n, 10_000, 50_000), 0n);
  assert.equal(localSecondsLeft(30n, 10_000, 5_000), 30n, "a clock skew backwards is clamped");
  assert.equal(localSecondsElapsed(12n, 10_000, 13_500), 15n);
});
