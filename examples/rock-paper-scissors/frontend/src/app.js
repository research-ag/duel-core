// Bootstrap for the rock-paper-scissors client: build the actor and push transport,
// hand off to duel-game-core's generic wiring, then wire the leaderboard
// and bot-challenge overlays. Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { makeIdlFactory, buildBotPlayIdlFactory } from "duel-game-core/idl.js";
import { start } from "duel-game-core/app.js";
import { connectWs } from "duel-game-core/ws.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { debriefVerdict, errText, esc, renderBotList, renderLeaderboard, renderSeatChoice, tag } from "duel-game-core/render.js";
import { plugin, renderLastRound } from "./rps-plugin.js";

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

// An Internet Identity login if active, else a persisted anonymous keypair.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });

// The debrief is this game's own: a final scoreline and the deciding
// round instead of the generic board. Every other screen stays the default.
function renderRpsDebrief(v, p) {
  const me = tag(v.seat);
  const opp = me === "p1" ? "p2" : "p1";
  const score = (seat) => (seat === "p1" ? v.finalGame.p1Score : v.finalGame.p2Score);
  const { title, outcome } = debriefVerdict(v.end, me);
  return `
    <h2 class="verdict ${outcome}">${title}</h2>
    <p class="rps-final">
      <span class="rps-final-you">${score(me)}</span>
      <span class="vs">–</span>
      <span class="rps-final-opp">${score(opp)}</span>
    </p>
    ${renderLastRound(v.finalGame, me, opp)}
    <p class="muted">${v.turns} round${v.turns === 1n ? "" : "s"} of ${esc(p.formatVariant(Object.keys(v.finalGame.variant)[0]))}.</p>
    <p>
      <button data-rematch class="primary">Play again</button>
      <button data-leave class="ghost">Back to the lobby</button>
    </p>`;
}

start({ plugin, ws, session, screens: { debrief: renderRpsDebrief } });

// Leaderboard: a full-page overlay fetched via plain queries on open.
const leaderboardToggle = document.getElementById("leaderboard-toggle");
const leaderboardBack = document.getElementById("leaderboard-back");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const leaderboardBody = document.getElementById("leaderboard-body");
leaderboardToggle.addEventListener("click", async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="muted">Loading…</p>`;
  try {
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

// "🤖 Bots": two entry points (the staging screen's "Add Bot" button and a
// leaderboard row's Challenge button) converge on one flow that calls the
// chosen bot's own `play` directly. See ../../../frontend/README.md,
// "Bot registry".
const hostPrincipal = Principal.fromText(canisterId);
const botPanel = document.getElementById("bot-challenge-panel");
const botBack = document.getElementById("bot-challenge-back");
const botBody = document.getElementById("bot-challenge-body");
const botAddPanel = document.getElementById("bot-add-panel");
const botAddTrigger = document.getElementById("bot-add-trigger");

// `lastBot` remembers the bot and table of the last successful `play`, so a
// Rematch from that game re-invites it when the reserved staging lands.
const LAST_BOT_KEY = "duel-last-bot";
let lastBot = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(LAST_BOT_KEY));
  if (saved) lastBot = { ...saved, tableId: BigInt(saved.tableId) };
} catch (_) {}
function setLastBot(bot) {
  lastBot = bot;
  try {
    if (bot) sessionStorage.setItem(LAST_BOT_KEY, JSON.stringify({ ...bot, tableId: bot.tableId.toString() }));
    else sessionStorage.removeItem(LAST_BOT_KEY);
  } catch (_) {}
}
// The open seat and code of this session's own staging, tracked off the
// live status push; `null` on any other screen.
let staging = null;
ws.addEventListener("message", (ev) => {
  const payload = ev.data;
  if (!payload || "err" in payload) {
    staging = null;
    botAddPanel.hidden = true;
    return;
  }
  const status = payload.view;
  const atTable = "atTable" in status ? status.atTable : null;
  if (lastBot && !(atTable && atTable.id === lastBot.tableId)) setLastBot(null);
  if (!atTable || tag(atTable.view) !== "stagingYou") {
    staging = null;
    botAddPanel.hidden = true;
    return;
  }
  const v = atTable.view.stagingYou;
  staging = {
    tableId: atTable.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
  botAddPanel.hidden = false;
  if (lastBot && v.reservedForPartner && !pendingBot) {
    onChallengeClick(lastBot.principalText, lastBot.name, lastBot.complexity);
  }
});

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

// This session's own staging (`seat === undefined`), or a new table.
async function stageFor(seat) {
  if (seat === undefined) return staging;
  const res = await ws.request(session.sid, { createTable: { seat: { [seat]: null }, visibility: { open: null }, variant: "" } });
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
  const { principalText, name, complexity } = pendingBot;
  botBody.innerHTML = `<p class="muted">Inviting ${esc(name)} (${esc(complexity)})…</p>`;
  try {
    const { tableId, openSeat, code } = await stageFor(seat);
    const botActor = Actor.createActor(buildBotPlayIdlFactory, { agent, canisterId: principalText });
    const res = await botActor.play(hostPrincipal, tableId, openSeat, code, complexity);
    if ("err" in res) throw new Error(errText(res.err));
    // The bot's join pushes a fresh status to this connection on its own.
    setLastBot({ principalText, name, complexity, tableId });
    botPanel.hidden = true;
    pendingBot = null;
  } catch (e) {
    botBody.innerHTML = `<p class="error">${esc(e && e.message ? e.message : String(e))}</p>`;
  }
}

function onChallengeClick(principalText, name, complexity) {
  pendingBot = { principalText, name, complexity };
  leaderboardPanel.hidden = true;
  botPanel.hidden = false;
  if (staging) {
    void inviteBot(undefined);
  } else {
    botBody.innerHTML = renderSeatChoice(plugin);
  }
}

botBody.addEventListener("click", (ev) => {
  const seatBtn = ev.target.closest("[data-challenge-seat]");
  if (seatBtn) {
    void inviteBot(seatBtn.dataset.challengeSeat);
    return;
  }
  const botBtn = ev.target.closest("[data-challenge-bot]");
  if (botBtn) onChallengeClick(botBtn.dataset.challengeBot, botBtn.dataset.botName || botBtn.dataset.challengeBot, botBtn.dataset.botComplexity || "");
});
leaderboardBody.addEventListener("click", (ev) => {
  const botBtn = ev.target.closest("[data-challenge-bot]");
  if (botBtn) onChallengeClick(botBtn.dataset.challengeBot, botBtn.dataset.botName || botBtn.dataset.challengeBot, botBtn.dataset.botComplexity || "");
});
