// Headless end-to-end check of follow-up moves: on a 2x2 board, Blue
// clicks a three-line turn (two boxes, then a free line) without waiting
// for replies. The client must queue the second and third lines behind
// the first and send them as one `duel_submit_moves`. Run from
// frontend/ against the local copy (icp deploy), or `<backend-id> --ic`.
//
// Line indices on 2x2: h(r, c) = r*2 + c, v(r, c) = 6 + r*3 + c.

import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { ANON_SID_PREFIX, sidFor } from "@research-ag/duel-game-core/anon-identity.js";
import { atTableOf, createDuelClient, viewOf } from "@research-ag/duel-game-core/client.js";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { plugin } from "./src/dots-and-boxes-plugin.js";

const args = process.argv.slice(2);
const onIc = args.includes("--ic");
const canisterId =
  args.find((a) => !a.startsWith("--")) ??
  execSync("icp canister status backend -i", { cwd: "..", encoding: "utf8" }).trim();
const host = onIc ? "https://icp-api.io" : "http://127.0.0.1:8000";
const WAIT_MS = 30_000;

async function player(name) {
  const identity = Ed25519KeyIdentity.generate();
  const principal = identity.getPrincipal();
  const session = { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
  const agent = await HttpAgent.create({ host, identity, shouldFetchRootKey: !onIc });
  const raw = Actor.createActor(makeIdlFactory(plugin.idlTypes), { agent, canisterId });
  const batches = [];
  const actor = new Proxy(raw, {
    get(target, prop) {
      if (prop === "duel_submit_moves") {
        return (id, gen, step, moves) => {
          batches.push(moves.map((m) => Number(m.draw.line)));
          return target.duel_submit_moves(id, gen, step, moves);
        };
      }
      return target[prop];
    },
  });
  const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });
  const client = createDuelClient({ transport, session, plugin });
  return { name, client, batches };
}

function until(p, what, pred) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${p.name}: no ${what} within ${WAIT_MS} ms`));
    }, WAIT_MS);
    const check = (state) => {
      if (!pred(state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = p.client.subscribe(check);
    check(p.client.getState());
  });
}

const inGame = (s) => viewOf(s.status, "inGame");
const myTurn = (s) => s.pending === null && inGame(s) !== null && !inGame(s).youSubmitted;
const draw = (line) => ({ draw: { line: BigInt(line) } });

async function play(p, line) {
  await until(p, `turn for line ${line}`, myTurn);
  const o = await p.client.submit(draw(line));
  if (!o.ok) throw new Error(`${p.name} line ${line}: ${o.reason} ${o.message ?? ""}`);
}

const blue = await player("blue");
const red = await player("red");
await until(blue, "connection", (s) => s.connection === "open");
await until(red, "connection", (s) => s.connection === "open");

const code = `fu${Date.now() % 100000}`;
const created = await blue.client.createTable("p1", { code }, { size: 2n });
if (!created.ok) throw new Error(`create: ${created.reason}`);
const id = atTableOf(blue.client.getState().status).id;
const joined = await red.client.joinTable(id, "p2", code);
if (!joined.ok) throw new Error(`join: ${joined.reason}`);

// Box 0 = {h0, h2, v6, v7}, box 1 = {h1, h3, v7, v8}: leave each one
// line short, then give Red a harmless line.
for (const [p, line] of [
  [blue, 2],
  [red, 6],
  [blue, 7],
  [red, 3],
  [blue, 8],
  [red, 5],
]) {
  await play(p, line);
}

await until(blue, "Blue's chain", myTurn);
const step0 = inGame(blue.client.getState()).step;
const outcomes = [blue.client.submit(draw(0))];
if (!blue.client.getState().followUp) throw new Error("box 0 closes: Blue should stay on turn locally");
outcomes.push(blue.client.submit(draw(1)), blue.client.submit(draw(9)));
const queued = blue.client.getState().queued.map((m) => Number(m.draw.line));
if (queued.join() !== "1,9") throw new Error(`queue should hold [1, 9], holds [${queued}]`);
for (const o of await Promise.all(outcomes)) if (!o.ok) throw new Error(`chain: ${o.reason} ${o.message ?? ""}`);

const after = await until(red, "Red's turn after the chain", myTurn);
const v = inGame(after);
const boxes = v.game.boxes.map((b) => (b.length ? Object.keys(b[0])[0] : null));
if (blue.batches.length !== 1 || blue.batches[0].join() !== "1,9") {
  throw new Error(`expected one duel_submit_moves([1, 9]), saw ${JSON.stringify(blue.batches)}`);
}
if (v.step !== step0 + 3n) throw new Error(`three steps expected, ${step0} -> ${v.step}`);
if (boxes[0] !== "p1" || boxes[1] !== "p1") throw new Error(`Blue should own boxes 0 and 1: ${boxes}`);

await red.client.leave();
await until(blue, "debrief", (s) => viewOf(s.status, "debrief") !== null);
await blue.client.ackEnded();
await red.client.ackEnded();
console.log("follow-up moves: one click-ahead chain, one duel_submit_moves([1, 9]), boxes 0 and 1 to Blue OK");
process.exit(0);
