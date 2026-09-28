// Bootstrap for the checkers client. Builds the actor and a push-shaped
// `ws` over it, then hands off to `duel-game-core`'s generic session/
// render wiring — everything that is the same for every game on this
// engine lives in the npm package, not here. This file only knows how to
// reach the canister and which GamePlugin to use.
//
// This file is bundled by esbuild (see ../build.js) into dist/app.js, so
// every import below — @icp-sdk/core and duel-game-core alike — resolves
// normally from node_modules at build time and ships as one self-
// contained bundle; the deployed asset canister carries no node_modules
// directory of its own. `duel-game-core` itself is fetched once via
// `npm install` (see package.json / .npmrc) — its own dist/ is what
// these imports resolve against (its source is TypeScript; see
// ../../../CLAUDE.md's "After touching anything under frontend/"
// section — `npm run build` there has to run BEFORE this example's own
// `npm install`, since this repo's `allow-scripts` gate blocks
// duel-game-core's own `prepare` script from doing it automatically).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { makeIdlFactory, buildBotPlayIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { errText, esc, renderBotList, renderLeaderboard, renderSeatChoice, tag } from "duel-game-core/render.js";
import { plugin } from "./checkers-plugin.js";

const env = readIcEnv();
const canisterId = env["PUBLIC_CANISTER_ID:backend"];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    "<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> " +
    "cookie. Serve this page from the asset canister after " +
    "<code>icp deploy</code>.</p>";
  throw new Error("missing canister id");
}

const host = deriveHost();

// This tab's own identity — a real, permanent Internet Identity login if
// one's already active, otherwise a persisted, non-spoofable anonymous
// keypair (no login required). See duel-game-core/README.md's "Logging
// in with Internet Identity" section for the full mechanism.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

// A real push transport — see ../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/ws's ic-websocket-cdk protocol directly, self-
// registering this tab as its own Gateway (see
// ../../../frontend/ws/gateway-transport.js) — genuine canister push,
// and a genuine server-side signal if this tab goes quiet. `principal`
// is the same identity `agent`/`actor` already sign calls with;
// `gameIdlTypes` supplies the Candid shape of this game's own
// Action/State (needed to decode the message content blob). `app.js`'s
// start() sends every action and refresh over this — there is no
// plain-actor-call/polling code path any more, `ws` is required.
const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });

start({ plugin, ws, session });

// The leaderboard: a dedicated full-page overlay (#leaderboard-panel,
// styled `position: fixed; inset: 0` — see duel-game-core.css — so the
// generic chrome's own live status pushes updating #screen underneath it
// can never clobber it), fetched fresh via a plain Candid query on the
// SAME actor `start()` already built (get_leaderboard needs no `ws`
// round-trip — see duel-game-core/README.md's "Leaderboard" section)
// each time it's opened, rather than kept live-pushed like the game
// screen itself. `yourSid: session.sid` lets renderLeaderboard pick out
// and badge this player's own row, if they're on the ranked list.
const leaderboardToggle = document.getElementById("leaderboard-toggle");
const leaderboardBack = document.getElementById("leaderboard-back");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const leaderboardBody = document.getElementById("leaderboard-body");
leaderboardToggle.addEventListener("click", async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    // Fetched alongside the ranked entries themselves (both plain Candid
    // queries, no `ws` round-trip either) purely so a bot's own row can
    // show its self-reported `name` instead of a bare principal — see
    // `renderLeaderboard`'s own `opts.botNames` doc. A `list_bots()`
    // failure (or a host with no bot discovery wired at all) still lets
    // the leaderboard itself render, just without any bot alias.
    const [entries, bots] = await Promise.all([actor.get_leaderboard(), actor.list_bots().catch(() => [])]);
    const botNames = new Map(bots.map((b) => [b.principal.toString(), b.name]));
    leaderboardBody.innerHTML = renderLeaderboard(entries, plugin, { yourSid: session.sid, botNames });
  } catch (err) {
    leaderboardBody.innerHTML = `<p class="error">Could not load the leaderboard.</p>`;
    console.error(err);
  }
});
leaderboardBack.addEventListener("click", () => {
  leaderboardPanel.hidden = true;
});

// ── "🤖 Bots" — discover and challenge any bot that's self-registered
// with THIS host (see ../../../backend/README.md's "Canister players"
// section, "Bot discovery") ───────────────────────────────────────────
// Two entry points converge on the SAME challenge flow below:
//   - `#bot-add-panel`'s own "Add Bot" button (`index.html`, a sibling of
//     `#screen`) — Flow 1's own human-facing entry point, exactly where
//     the old single-hardcoded-bot version of this control lived: shown
//     ONLY for the "Waiting for an opponent" screen (`stagingYou`,
//     tracked below), since that's the one screen where a seat's already
//     been picked (via the ordinary "Start a new table" flow) and there's
//     an open seat to fill. Clicking it opens `#bot-challenge-panel` with
//     the ranked bot list (`list_bots()` — a plain Candid query, same
//     class as `get_leaderboard()` above, no `ws` round-trip); picking a
//     bot fills THAT table's own open seat directly, no further choice
//     needed.
//   - a bot's own row in the leaderboard panel above (`renderLeaderboard`'s
//     own Challenge button) — reachable from ANY screen, so it can't
//     assume an open seat already exists: if this player isn't already
//     staging a table, a seat-choice step (`renderSeatChoice`) creates a
//     brand-new one first — a normal `createTable` request sent directly
//     over the shared `ws` (`ws.request`, the same correlatable call the
//     checkers board's own move submission already relies on for a scoped
//     reply, just issued from here instead of from a `data-create-table`
//     button inside `#screen`).
//
// Either way, the actual invite is the same PLAIN Candid call straight to
// the bot's own `play(host, tableId, seat, code)` (see `../../bot/Bot.mo`)
// Flow 1 always used — never routed through `ws.mo`'s protocol — except
// now the target canister id comes from whichever bot a player picked in
// `renderBotList`/`renderLeaderboard`, never a hardcoded env var.
const hostPrincipal = Principal.fromText(canisterId);
const botPanel = document.getElementById("bot-challenge-panel");
const botBack = document.getElementById("bot-challenge-back");
const botBody = document.getElementById("bot-challenge-body");
const botAddPanel = document.getElementById("bot-add-panel");
const botAddTrigger = document.getElementById("bot-add-trigger");

// Refreshed off every status push with exactly what a same-table
// challenge needs: the open seat (the one this session ISN'T holding)
// and the access code, if any (`StagingYouView.visibility` — known only
// to this table's own occupant, exactly the caller here). `null` outside
// the "Waiting for an opponent" screen specifically — not merely "at a
// table" (browsing/busy/awaitingRematch/inGame/debrief/endedByOther all
// clear it, and hide `#bot-add-panel` right along with it). `ws`
// (GatewayWs) extends EventTarget specifically so more than one consumer
// can listen without stealing app.js's own `ws.onmessage` — see the
// duel-game-core skill's rich-UI pattern.
let staging = null;
ws.addEventListener("message", (ev) => {
  const payload = ev.data;
  if (!payload || "err" in payload) {
    staging = null;
    botAddPanel.hidden = true;
    return;
  }
  const status = payload.view;
  if (!("atTable" in status) || tag(status.atTable.view) !== "stagingYou") {
    staging = null;
    botAddPanel.hidden = true;
    return;
  }
  const v = status.atTable.view.stagingYou;
  staging = {
    tableId: status.atTable.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
  botAddPanel.hidden = false;
});

// The bot chosen off either entry point, waiting on a seat pick — `null`
// whenever the dialog isn't mid-challenge.
let pendingBot = null;

function openBotPanel(bodyHtml) {
  leaderboardPanel.hidden = true;
  botPanel.hidden = false;
  botBody.innerHTML = bodyHtml;
}

async function loadBotList() {
  pendingBot = null;
  openBotPanel(`<p class="muted">Loading…</p>`);
  try {
    const bots = await actor.list_bots();
    botBody.innerHTML = renderBotList(bots, plugin);
  } catch (err) {
    botBody.innerHTML = `<p class="error">Could not load bots.</p>`;
    console.error(err);
  }
}
botAddTrigger.addEventListener("click", () => void loadBotList());
botBack.addEventListener("click", () => {
  botPanel.hidden = true;
  pendingBot = null;
});

// One table id/seat/code to hand `bot.play` — either this session's own
// already-staged table (`seat === undefined`), or a brand-new one created
// on the spot for the chosen `seat`.
async function stageFor(seat) {
  if (seat === undefined) return staging;
  const res = await ws.request(session.sid, { createTable: { seat: { [seat]: null }, visibility: { open: null } } });
  if ("err" in res) throw new Error(errText(res.err));
  const status = res.view;
  if (!("atTable" in status) || tag(status.atTable.view) !== "stagingYou") {
    throw new Error("Could not stage a table.");
  }
  const v = status.atTable.view.stagingYou;
  return {
    tableId: status.atTable.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
}

async function inviteBot(seat) {
  const { principalText, name } = pendingBot;
  botBody.innerHTML = `<p class="muted">Inviting ${esc(name)}…</p>`;
  try {
    const { tableId, openSeat, code } = await stageFor(seat);
    const botActor = Actor.createActor(buildBotPlayIdlFactory, { agent, canisterId: principalText });
    const res = await botActor.play(hostPrincipal, tableId, openSeat, code);
    if ("err" in res) throw new Error(errText(res.err));
    // On success the bot's own `join_table_as_canister` call reuses
    // `attached.afterMutation` (Host.mo) to push a fresh status to THIS
    // human's own connection in real time — app.js's own `ws.onmessage`
    // picks it up and re-renders #screen to the fresh #active game on
    // its own; nothing further to do here.
    botPanel.hidden = true;
    pendingBot = null;
  } catch (e) {
    botBody.innerHTML = `<p class="error">${esc(e && e.message ? e.message : String(e))}</p>`;
  }
}

function onChallengeClick(principalText, name) {
  pendingBot = { principalText, name };
  leaderboardPanel.hidden = true;
  botPanel.hidden = false;
  if (staging) {
    void inviteBot(undefined);
  } else {
    botBody.innerHTML = renderSeatChoice(plugin);
  }
}

// Delegated on each STABLE container (never re-bound after an `innerHTML`
// swap) so both this dialog's own bot list and its own seat-choice step
// share one listener, and the leaderboard panel's per-row Challenge
// button (`renderLeaderboard`) reaches the exact same flow.
botBody.addEventListener("click", (ev) => {
  const seatBtn = ev.target.closest("[data-challenge-seat]");
  if (seatBtn) {
    void inviteBot(seatBtn.dataset.challengeSeat);
    return;
  }
  const botBtn = ev.target.closest("[data-challenge-bot]");
  if (botBtn) onChallengeClick(botBtn.dataset.challengeBot, botBtn.dataset.botName || botBtn.dataset.challengeBot);
});
leaderboardBody.addEventListener("click", (ev) => {
  const botBtn = ev.target.closest("[data-challenge-bot]");
  if (botBtn) onChallengeClick(botBtn.dataset.challengeBot, botBtn.dataset.botName || botBtn.dataset.challengeBot);
});
