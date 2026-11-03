// Headless end-to-end check for Dots & Boxes: two players with fresh
// keys play whole games through the real client (`createDuelClient` over
// `connectTransport`), every move picked from the plugin's own
// board and action buttons, exactly as a click would send it. Then a
// rematch, a leave, and both debriefs acked. Run from frontend/:
//
//   node play-test.mjs                     # the local copy (icp deploy)
//   node play-test.mjs <backend-id> --ic   # a backend on mainnet
//
// Every table it opens is access-code protected. Exit code 0 means every
// game reached its ending.

import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { ANON_SID_PREFIX, sidFor } from "@research-ag/duel-game-core/anon-identity.js";
import { atTableOf, createDuelClient, viewOf } from "@research-ag/duel-game-core/client.js";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { tag } from "@research-ag/duel-game-core/render.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { plugin } from "./src/dots-and-boxes-plugin.js";

const args = process.argv.slice(2);
const onIc = args.includes("--ic");
const canisterId =
  args.find((a) => !a.startsWith("--")) ??
  execSync("icp canister status backend -i", { cwd: "..", encoding: "utf8" }).trim();
const host = onIc ? "https://icp-api.io" : "http://127.0.0.1:8000";
const MAX_MOVES = 2000;
const WAIT_MS = 30_000;

const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

async function player(name) {
  const identity = Ed25519KeyIdentity.generate();
  const principal = identity.getPrincipal();
  const session = { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
  const agent = await HttpAgent.create({ host, identity, shouldFetchRootKey: !onIc });
  const actor = Actor.createActor(makeIdlFactory(plugin.idlTypes), { agent, canisterId });
  const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
  const client = createDuelClient({ transport, session });
  return { name, client, transport };
}

// Resolves once `pred(state)` holds for one of `ps`; fails with their
// last statuses.
function until(ps, what, pred) {
  return new Promise((resolve, reject) => {
    const unsubscribes = [];
    const done = () => {
      clearTimeout(timer);
      unsubscribes.forEach((u) => u());
    };
    const timer = setTimeout(() => {
      done();
      const last = ps.map((p) => `${p.name}: ${show(p.client.getState().status)}`).join("; ");
      reject(new Error(`no ${what} within ${WAIT_MS} ms; last status ${last}`));
    }, WAIT_MS);
    for (const p of ps) {
      const check = (state) => {
        if (!pred(state)) return;
        done();
        resolve(state);
      };
      unsubscribes.push(p.client.subscribe(check));
      check(p.client.getState());
    }
  });
}

const viewIs = (t) => (s) => s.status !== null && viewOf(s.status, t) !== null;

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The moves a seat could click: every `actionAttr` element of the board
// and the action panel, split into enabled and disabled. A game whose
// moves are not single clicks on such elements (a two-click selection, a
// canvas, drag and drop) lists its legal moves here itself.
function offeredMoves(game, seat) {
  const opp = seat === "p1" ? "p2" : "p1";
  const html = plugin.renderBoard(game, seat, opp, true) + plugin.renderActions(game, seat);
  const enabled = [];
  const disabled = [];
  for (const [, attrs] of html.matchAll(/<\w+\b([^>]*\bdata-act='[^']*'[^>]*)>/g)) {
    const act = JSON.parse(decodeEntities(attrs.match(/data-act='([^']*)'/)[1]));
    (/\bdisabled\b/.test(attrs) ? disabled : enabled).push(act);
  }
  return { enabled, disabled };
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// Moves for whichever seat is due until both see a debrief.
async function playOut(a, b) {
  let moves = 0;
  let illegalTried = false;
  const rejectedAt = new Map();
  for (;;) {
    const states = [a, b].map((p) => p.client.getState());
    if (states.every(viewIs("debrief"))) return viewOf(states[0].status, "debrief");
    let moved = false;
    for (const p of [a, b]) {
      const v = viewOf(p.client.getState().status, "inGame");
      if (!v || v.youSubmitted || p.client.getState().pending) continue;
      const seat = tag(v.seat);
      const key = `${p.name}:${v.gen}:${v.step}`;
      const tried = rejectedAt.get(key) ?? [];
      const { enabled, disabled } = offeredMoves(v.game, seat);
      if (!illegalTried && disabled.length > 0) {
        illegalTried = true;
        const move = pick(disabled);
        const out = await p.client.submit(move);
        if (out.ok) console.warn(`  ! ${p.name}: a disabled button's move ${show(move)} was accepted; legal() is stricter than the rules`);
        else console.log(`  ${p.name}: illegal ${show(move)} rejected (${out.message ?? out.reason})`);
        moved = true;
        continue;
      }
      const choices = enabled.filter((m) => !tried.some((t) => show(t) === show(m)));
      if (choices.length === 0) throw new Error(`${p.name} (${seat}) is due but no button offers a move it accepts; view ${show(v)}`);
      const move = pick(choices);
      if (plugin.applyLocal) plugin.applyLocal(v.game, seat, move);
      const out = await p.client.submit(move);
      if (!out.ok && out.reason === "rejected") {
        console.warn(`  ! ${p.name}: offered move ${show(move)} rejected: ${out.message}`);
        rejectedAt.set(key, [...tried, move]);
      }
      if (++moves > MAX_MOVES) throw new Error(`no ending after ${MAX_MOVES} moves`);
      moved = true;
    }
    if (!moved) {
      const before = [a, b].map((p) => p.client.getState().status);
      await until([a, b], "progress", () =>
        [a, b].some((p, i) => p.client.getState().status !== before[i] && p.client.getState().pending === null),
      );
    }
  }
}

async function oneGame(options, label) {
  const a = await player("A");
  const b = await player("B");
  try {
    const code = `t${Math.floor(Math.random() * 1e9)}`;
    let out = await a.client.createTable("p1", { code }, options);
    if (!out.ok) throw new Error(`createTable: ${out.message ?? out.reason}`);
    const { id } = atTableOf((await until([a], "staging", viewIs("stagingYou"))).status);
    out = await b.client.joinTable(id, "p2", code);
    if (!out.ok) throw new Error(`joinTable: ${out.message ?? out.reason}`);
    await until([a], "game start", viewIs("inGame"));

    const d = await playOut(a, b);
    console.log(`${label}: table ${id}, ${show(d.end)} after ${d.steps} steps`);

    out = await a.client.rematch();
    if (!out.ok) throw new Error(`A rematch: ${out.message ?? out.reason}`);
    out = await b.client.rematch();
    if (!out.ok) throw new Error(`B rematch: ${out.message ?? out.reason}`);
    await until([a], "rematch start", viewIs("inGame"));
    await until([b], "rematch start", viewIs("inGame"));

    out = await a.client.leave();
    if (!out.ok) throw new Error(`leave: ${out.message ?? out.reason}`);
    for (const p of [a, b]) {
      const s = await until([p], "aborted debrief", viewIs("debrief"));
      if (!("aborted" in viewOf(s.status, "debrief").end)) throw new Error(`${p.name}: expected an aborted debrief`);
      const ack = await p.client.ackEnded();
      if (!ack.ok) throw new Error(`${p.name} ack: ${ack.message ?? ack.reason}`);
    }
    console.log(`${label}: rematch started, left, both debriefs acked`);
  } finally {
    for (const p of [a, b]) {
      p.client.dispose();
      p.transport.close();
    }
  }
}

const choices = plugin.optionChoices?.() ?? [{ key: "default", options: {} }];
console.log(`play-test against ${canisterId} on ${host}`);
for (const c of choices) await oneGame(c.options, c.key);
console.log("PLAY-TEST PASSED");
process.exit(0);
