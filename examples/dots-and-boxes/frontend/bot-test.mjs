// Headless check of the bot and the leaderboard for Dots & Boxes: a player
// with a fresh key opens an access-code table per bot complexity, invites
// the registered bot through its own `play` (exactly what the page's 🤖
// dialog does), plays random legal lines from the plugin's own buttons
// until the debrief, then checks that `get_leaderboard` rated both.
// Run from frontend/, after the bot registered with the backend:
//
//   node bot-test.mjs                     # the local copy (icp deploy)
//   node bot-test.mjs <backend-id> --ic   # mainnet
//
// Exit code 0 means every game against every complexity reached its end.

import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { ANON_SID_PREFIX, sidFor } from "@research-ag/duel-game-core/anon-identity.js";
import { botPlayer, createBotInviter } from "@research-ag/duel-game-core/bots.js";
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
const WAIT_MS = 60_000;
const MAX_MOVES = 400;
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

function until(client, what, pred) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`no ${what} within ${WAIT_MS} ms; last status ${show(client.getState().status)}`));
    }, WAIT_MS);
    const check = (state) => {
      if (!pred(state)) return;
      clearTimeout(timer);
      unsub();
      resolve(state);
    };
    const unsub = client.subscribe(check);
    check(client.getState());
  });
}
const viewIs = (t) => (s) => s.status !== null && viewOf(s.status, t) !== null;

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function offeredMoves(game, seat) {
  const opp = seat === "p1" ? "p2" : "p1";
  const html = plugin.renderBoard(game, seat, opp, true) + plugin.renderActions(game, seat);
  const out = [];
  for (const [, attrs] of html.matchAll(/<\w+\b([^>]*\bdata-act='[^']*'[^>]*)>/g)) {
    if (!/\bdisabled\b/.test(attrs)) out.push(JSON.parse(decodeEntities(attrs.match(/data-act='([^']*)'/)[1])));
  }
  return out;
}
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

const identity = Ed25519KeyIdentity.generate();
const principal = identity.getPrincipal();
const session = { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
const agent = await HttpAgent.create({ host, identity, shouldFetchRootKey: !onIc });
const actor = Actor.createActor(makeIdlFactory(plugin.idlTypes), { agent, canisterId });
const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
const client = createDuelClient({ transport, session });
const inviter = createBotInviter({ client, play: botPlayer(agent, canisterId), storage: null });

console.log(`bot-test against ${canisterId} on ${host}`);
const bots = await actor.list_bots();
if (bots.length === 0) throw new Error("no bot is registered with this backend");
const bot = bots[0];
const complexities = bot.complexities.map((c) => (typeof c === "string" ? c : c.complexity));
console.log(`bot "${bot.name}" (${bot.principal.toText()}), complexities ${complexities.join(", ")}`);

async function oneGame(complexity, mySeat) {
  const code = `b${Math.floor(Math.random() * 1e9)}`;
  let out = await client.createTable(mySeat, { code }, { size: 3n });
  if (!out.ok) throw new Error(`createTable: ${out.message ?? out.reason}`);
  const { id } = atTableOf((await until(client, "staging", viewIs("stagingYou"))).status);
  const joined = await inviter.challenge({ principal: bot.principal.toText(), name: bot.name, complexity });
  if (!joined) throw new Error(`bot did not join: ${inviter.getState?.().error ?? "unknown"}`);
  await until(client, "game start", viewIs("inGame"));

  let moves = 0;
  for (;;) {
    const state = client.getState();
    if (viewIs("debrief")(state)) break;
    const v = viewOf(state.status, "inGame");
    if (v && !v.youSubmitted && !state.pending) {
      const seat = tag(v.seat);
      const move = pick(offeredMoves(v.game, seat));
      const res = await client.submit(move);
      if (!res.ok && res.reason === "rejected") throw new Error(`move ${show(move)} rejected: ${res.message}`);
      if (++moves > MAX_MOVES) throw new Error("no ending");
      continue;
    }
    const before = state.status;
    await until(client, "progress", (s) => s.status !== before && s.pending === null);
  }
  const d = viewOf(client.getState().status, "debrief");
  const me = tag(d.seat);
  const game = d.finalGame;
  const mine = game.boxes.filter((b) => b.length && me in b[0]).length;
  const theirs = game.boxes.filter((b) => b.length && !(me in b[0])).length;
  console.log(`${complexity}: table ${id}, I was ${me}, ${show(d.end)} after ${d.steps} steps, boxes ${mine}:${theirs}`);
  out = await client.leave();
  if (!out.ok) throw new Error(`leave: ${out.message ?? out.reason}`);
  await until(client, "back in the lobby", (s) => s.status !== null && viewOf(s.status, "debrief") === null && viewOf(s.status, "inGame") === null);
  return { mine, theirs, end: d.end };
}

try {
  const results = {};
  let seat = "p1";
  for (const c of complexities) {
    results[c] = await oneGame(c, seat);
    seat = seat === "p1" ? "p2" : "p1";
  }
  const board = await actor.get_leaderboard();
  const keys = board.map((e) => e.player ?? e.key ?? Object.values(e)[0]);
  console.log(`leaderboard has ${board.length} entries: ${show(board.slice(0, 4))}`);
  const botRows = board.filter((e) => show(e).includes(`cp:${bot.principal.toText()}`));
  if (botRows.length < complexities.length) throw new Error(`expected a leaderboard row per complexity, got ${botRows.length}`);
  if (!board.some((e) => show(e).includes(principal.toText()))) throw new Error("the human player is not on the leaderboard");
  console.log("BOT-TEST PASSED");
} finally {
  client.dispose();
  transport.close();
}
process.exit(0);
