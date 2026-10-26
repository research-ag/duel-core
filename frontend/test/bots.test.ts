import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeElement, makeFakeDocument, makeButton } from "./support/fake-dom.js";
import type { ClientState, DuelClient, CallOutcome } from "../src/client.js";
import type { BotRef, PlayBot, Staging } from "../src/bots.js";
import type { GamePlugin, Status } from "../src/types.js";

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function staging(id = 7n, opts: { reserved?: boolean; gen?: bigint; seat?: "p1" | "p2" } = {}): Status {
  return {
    atTable: {
      id,
      view: {
        stagingYou: {
          seat: { [opts.seat ?? "p1"]: null },
          reservedForPartner: opts.reserved ?? false,
          gen: opts.gen ?? 0n,
          visibility: { open: null },
        },
      },
    },
  } as Status;
}
const browsing: Status = { browsing: { tables: [] } } as Status;
const inGame = (id = 7n): Status => ({ atTable: { id, view: { inGame: {} } } }) as Status;

function fakeClient(initial: Status | null = null) {
  let state = { status: initial } as ClientState;
  const listeners = new Set<(s: ClientState, p: ClientState) => void>();
  const created: Array<{ seat: string; options: unknown }> = [];
  let createOutcome: CallOutcome = { ok: true, view: staging(9n) };
  const client = {
    getState: () => state,
    subscribe(fn: (s: ClientState, p: ClientState) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async createTable(seat: string, _vis: unknown, options: unknown) {
      created.push({ seat, options });
      return createOutcome;
    },
  } as unknown as DuelClient;
  return {
    client,
    created,
    push(status: Status | null) {
      const prev = state;
      state = { ...state, status };
      for (const fn of listeners) fn(state, prev);
    },
    setCreateOutcome(o: CallOutcome) {
      createOutcome = o;
    },
  };
}

function fakePlay(reply: () => Promise<{ ok: unknown } | { err: never }> = async () => ({ ok: { started: { p2: null } } })) {
  const calls: Array<{ bot: BotRef; staging: Staging }> = [];
  const play: PlayBot = (bot, s) => {
    calls.push({ bot, staging: s });
    return reply();
  };
  return { play, calls };
}

const bot: BotRef = { principal: "aaaaa-aa", name: "Fox", complexity: "Hard" };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("createBotInviter: fills this session's own waiting table without creating one", async () => {
  const { createBotInviter } = await import("../src/bots.js");
  const c = fakeClient(staging(7n, { seat: "p2" }));
  const p = fakePlay();
  const inv = createBotInviter({ client: c.client, play: p.play, storage: new FakeStorage() });
  assert.deepEqual(inv.getState().staging, { tableId: 7n, openSeat: { p1: null }, code: [] });
  assert.equal(await inv.challenge(bot), true);
  assert.equal(c.created.length, 0);
  assert.equal(p.calls[0].staging.tableId, 7n);
  assert.equal(inv.getState().inviting, null);
});

test("createBotInviter: creates a table in the chosen seat with the given options, then invites", async () => {
  const { createBotInviter } = await import("../src/bots.js");
  const c = fakeClient(browsing);
  const p = fakePlay();
  const inv = createBotInviter({ client: c.client, play: p.play, options: { n: 1n }, storage: new FakeStorage() });
  assert.equal(await inv.challenge(bot), false);
  assert.match(inv.getState().error ?? "", /seat/);
  assert.equal(await inv.challenge(bot, "p2"), true);
  assert.deepEqual(c.created, [{ seat: "p2", options: { n: 1n } }]);
  assert.equal(p.calls[0].staging.tableId, 9n);
});

test("createBotInviter: a failed create or play lands in `error`", async () => {
  const { createBotInviter } = await import("../src/bots.js");
  const c = fakeClient(browsing);
  c.setCreateOutcome({ ok: false, reason: "failed", message: "boom" });
  const p = fakePlay(async () => ({ err: { tooManyTables: { max: 50n } } as never }));
  const inv = createBotInviter({ client: c.client, play: p.play, storage: new FakeStorage() });
  assert.equal(await inv.challenge(bot, "p1"), false);
  assert.equal(inv.getState().error, "boom");
  c.push(staging(7n));
  assert.equal(await inv.challenge(bot), false);
  assert.equal(inv.getState().error, "Fox (Hard) is already playing 50 games — try again shortly.");
});

test("createBotInviter: a rematch staged for the bot re-invites it once per gen, and the memory clears off that table", async () => {
  const { createBotInviter } = await import("../src/bots.js");
  const storage = new FakeStorage();
  const c = fakeClient(staging(7n));
  const p = fakePlay();
  const inv = createBotInviter({ client: c.client, play: p.play, storage });
  await inv.challenge(bot);
  assert.ok(storage.getItem("duel-last-bot"));
  c.push(inGame());
  c.push(staging(7n, { reserved: true, gen: 1n }));
  await tick();
  c.push(staging(7n, { reserved: true, gen: 1n }));
  await tick();
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.calls[1].bot, bot);
  c.push(browsing);
  assert.equal(storage.getItem("duel-last-bot"), null);
  c.push(staging(7n, { reserved: true, gen: 2n }));
  await tick();
  assert.equal(p.calls.length, 2);
  inv.dispose();
});

test("createBotInviter: the remembered bot survives a reload in the same tab", async () => {
  const { createBotInviter } = await import("../src/bots.js");
  const storage = new FakeStorage();
  storage.setItem("duel-last-bot", JSON.stringify({ ...bot, tableId: "7" }));
  const c = fakeClient(null);
  const p = fakePlay();
  createBotInviter({ client: c.client, play: p.play, storage });
  c.push(staging(7n, { reserved: true, gen: 3n }));
  await tick();
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].bot, bot);
});

// ── The overlays ──────────────────────────────────────────────────────────

const plugin = {
  seatLabel: (s: string) => (s === "p1" ? "Red" : "Yellow"),
  optionChoices: () => [{ key: "a", label: "A", options: { first: true } }],
} as unknown as GamePlugin;

function dom() {
  const els: Record<string, FakeElement> = {};
  for (const id of [
    "bot-challenge-panel",
    "bot-challenge-body",
    "bot-challenge-back",
    "bot-add-panel",
    "bot-add-trigger",
    "leaderboard-toggle",
    "leaderboard-panel",
    "leaderboard-body",
    "leaderboard-back",
  ]) {
    els[id] = new FakeElement();
    els[id].hidden = id.endsWith("panel");
  }
  (globalThis as unknown as { document: unknown }).document = makeFakeDocument(els);
  return els;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

const actor = {
  list_bots: async () => [{ principal: { toString: () => "aaaaa-aa" }, name: "Fox", complexities: [{ complexity: "Hard", elo: [] }] }],
  get_leaderboard: async () => [],
} as never;

test("mountBotChallenge: Add Bot shows only while waiting; list → pick → invite → panel closes", async () => {
  const { mountBotChallenge } = await import("../src/bots.js");
  const els = dom();
  const c = fakeClient(browsing);
  const p = fakePlay();
  mountBotChallenge({ client: c.client, actor, plugin, play: p.play, storage: new FakeStorage() });
  assert.equal(els["bot-add-panel"].hidden, true);
  c.push(staging(7n));
  assert.equal(els["bot-add-panel"].hidden, false);

  els["bot-add-trigger"].dispatch("click", {});
  await tick();
  assert.equal(els["bot-challenge-panel"].hidden, false);
  assert.match(els["bot-challenge-body"].innerHTML, /Fox \(Hard\)/);

  els["bot-challenge-body"].dispatch("click", {
    target: makeButton({ challengeBot: "aaaaa-aa", botName: "Fox", botComplexity: "Hard" }),
  });
  await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(els["bot-challenge-panel"].hidden, true);
});

test("mountBotChallenge: a Challenge while seated elsewhere asks to leave first and opens no table", async () => {
  const { mountBotChallenge } = await import("../src/bots.js");
  const els = dom();
  const c = fakeClient(inGame());
  const p = fakePlay();
  const bots = mountBotChallenge({ client: c.client, actor, plugin, play: p.play, storage: new FakeStorage() });
  bots.pick(bot);
  assert.equal(els["bot-challenge-panel"].hidden, false);
  assert.match(els["bot-challenge-body"].innerHTML, /Leave your current table/);
  assert.doesNotMatch(els["bot-challenge-body"].innerHTML, /data-challenge-seat/);
  els["bot-challenge-body"].dispatch("click", { target: makeButton({ challengeSeat: "p1" }) });
  await tick();
  assert.equal(c.created.length, 0);
  assert.equal(p.calls.length, 0);
});

test("mountBotChallenge + mountLeaderboard: a leaderboard Challenge while browsing asks for a seat, then creates with the first option", async () => {
  const { mountBotChallenge, mountLeaderboard } = await import("../src/bots.js");
  const els = dom();
  const c = fakeClient(browsing);
  const p = fakePlay(async () => ({ err: { seatTaken: null } as never }));
  const bots = mountBotChallenge({ client: c.client, actor, plugin, play: p.play, storage: new FakeStorage() });
  mountLeaderboard({ actor, plugin, sid: "me", onChallenge: bots.pick });

  els["leaderboard-toggle"].dispatch("click", {});
  await tick();
  assert.equal(els["leaderboard-panel"].hidden, false);
  els["leaderboard-body"].dispatch("click", {
    target: makeButton({ challengeBot: "aaaaa-aa", botName: "Fox", botComplexity: "Hard" }),
  });
  assert.equal(els["leaderboard-panel"].hidden, true);
  assert.equal(els["bot-challenge-panel"].hidden, false);
  assert.match(els["bot-challenge-body"].innerHTML, /data-challenge-seat="p2"/);

  els["bot-challenge-body"].dispatch("click", { target: makeButton({ challengeSeat: "p2" }) });
  await tick();
  await tick();
  assert.deepEqual(c.created, [{ seat: "p2", options: { first: true } }]);
  assert.equal(els["bot-challenge-panel"].hidden, false);
  assert.match(els["bot-challenge-body"].innerHTML, /class="error">That seat is already taken/);
});
