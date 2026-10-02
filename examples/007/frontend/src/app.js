// Bootstrap for the 007 duel client: build the actor and push transport,
// create duel-game-core's headless client, and mount 007's own UI over
// it (mission-ui.js). Nothing from `duel-game-core/app.js` runs here.
// Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { buildBotPlayIdlFactory, makeIdlFactory } from "duel-game-core/idl.js";
import { atTableOf, createDuelClient, errText, tag, viewOf } from "duel-game-core/client.js";
import { connectTransport } from "duel-game-core/transport.js";
import { resolveIdentity } from "duel-game-core/identity.js";
import { readIcEnv, deriveHost } from "duel-game-core/ic-env.js";
import { botDisplayName, renderBotList, renderLeaderboard, renderSeatChoice } from "duel-game-core/render.js";
import { plugin } from "./duel007-plugin.js";
import { mountMissionUi } from "./mission-ui.js";

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

const ws = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = createDuelClient({ ws, session });

const $ = (id) => document.getElementById(id);

// ── Bots ─────────────────────────────────────────────────────────────────
// A bot is seated by calling its own canister's `play`, never through the
// push channel. See ../../../frontend/README.md, "Bot registry".

// `render.js` words the bot-row button "Challenge"; this game says "Engage".
const engage = (html) => html.replaceAll(">Challenge</button>", ">Engage</button>");

const hostPrincipal = Principal.fromText(canisterId);
const LAST_BOT_KEY = "duel007-last-bot";

function stagingOf(status) {
  const at = atTableOf(status);
  const v = viewOf(status, "stagingYou");
  if (!at || !v) return null;
  return {
    tableId: at.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
}

function storageGet(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch (_) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

// The last bot seated, kept so a rematch (which reserves the seat for the
// bot's per-table session) can re-issue the identical `play`.
let lastBot = storageGet(LAST_BOT_KEY);
if (lastBot) lastBot = { ...lastBot, tableId: BigInt(lastBot.tableId) };
function setLastBot(bot) {
  lastBot = bot;
  storageSet(LAST_BOT_KEY, bot ? { ...bot, tableId: bot.tableId.toString() } : null);
}

const ui = mountMissionUi({
  client,
  plugin,
  els: {
    screen: $("mission"),
    alert: $("alert"),
    sid: $("sid"),
    newSid: $("new-sid"),
    auth: $("auth"),
    channel: $("channel"),
    log: $("log"),
    confirmDialog: $("confirm-forfeit"),
    codeDialog: $("enter-code"),
  },
  onAddBot: () => void openBots(),
});

function setInviting(bot) {
  ui.setInviting(bot === null ? null : botDisplayName(bot.name, bot.complexity));
}

async function inviteBot(bot, staging) {
  setInviting(bot);
  try {
    const botActor = Actor.createActor(buildBotPlayIdlFactory, { agent, canisterId: bot.principalText });
    const res = await botActor.play(hostPrincipal, staging.tableId, staging.openSeat, staging.code, bot.complexity);
    if ("err" in res) throw new Error(errText(res.err));
    setLastBot({ ...bot, tableId: staging.tableId });
    // The bot's join pushes a fresh status on its own; the invite stays up
    // until it lands, unless it already did.
    if (stagingOf(client.getState().status) === null) setInviting(null);
  } catch (e) {
    client.showError(e && e.message ? e.message : String(e));
    setInviting(null);
  }
}

async function startBotGame(bot, seat) {
  setInviting(bot);
  const res = await client.createTable(seat, { open: null }, "");
  const staging = res.ok ? stagingOf(res.view) : null;
  if (staging === null) {
    if (res.ok) client.showError("Could not stage a file.");
    setInviting(null);
    return;
  }
  await inviteBot(bot, staging);
}

function onState(state) {
  if (state.status === null) return;
  const at = atTableOf(state.status);
  if (lastBot && !(at && at.id === lastBot.tableId)) setLastBot(null);
  if (stagingOf(state.status) === null) setInviting(null);
}

// A rematch stages the same file with the seat held for the bot.
let reinvited = null;
function maybeReinvite(state) {
  const at = atTableOf(state.status);
  const v = viewOf(state.status, "stagingYou");
  if (!lastBot || !at || !v || !v.reservedForPartner) return;
  const key = `${at.id}:${v.gen}`;
  if (reinvited === key) return;
  reinvited = key;
  void inviteBot(lastBot, stagingOf(state.status));
}

client.subscribe((state) => {
  onState(state);
  maybeReinvite(state);
});

const botsPanel = $("bots-panel");
const botsBody = $("bots-body");
const seatDialog = $("challenge-seat");
let challenged = null;

async function openBots() {
  botsPanel.hidden = false;
  botsBody.innerHTML = `<p class="faint">Loading…</p>`;
  try {
    botsBody.innerHTML = engage(renderBotList(await actor.list_bots(), plugin));
  } catch (err) {
    botsBody.innerHTML = `<p class="alert">Could not load the bot agents.</p>`;
    console.error(err);
  }
}

function onChallengeClick(ev) {
  const b = ev.target.closest("[data-challenge-bot]");
  if (!b) return;
  const bot = {
    principalText: b.dataset.challengeBot,
    name: b.dataset.botName || b.dataset.challengeBot,
    complexity: b.dataset.botComplexity || "",
  };
  botsPanel.hidden = true;
  leaderboardPanel.hidden = true;
  const status = client.getState().status;
  const staging = stagingOf(status);
  if (staging !== null) return void inviteBot(bot, staging);
  if (status === null || !("browsing" in status)) return client.showError("Leave your current file before challenging a bot.");
  challenged = bot;
  $("challenge-seat-body").innerHTML = renderSeatChoice(plugin);
  seatDialog.showModal();
}

seatDialog.addEventListener("click", (ev) => {
  if (ev.target.closest("#challenge-cancel")) return seatDialog.close();
  const seat = ev.target.closest("[data-challenge-seat]");
  if (!seat) return;
  seatDialog.close();
  void startBotGame(challenged, seat.dataset.challengeSeat);
});
botsBody.addEventListener("click", onChallengeClick);
$("bots-toggle").addEventListener("click", () => void openBots());
$("bots-back").addEventListener("click", () => {
  botsPanel.hidden = true;
});

// Leaderboard: a full-page overlay fetched via a plain query on open.
const leaderboardPanel = $("leaderboard-panel");
const leaderboardBody = $("leaderboard-body");
leaderboardBody.addEventListener("click", onChallengeClick);
$("leaderboard-toggle").addEventListener("click", async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="faint">Loading…</p>`;
  try {
    const [entries, bots] = await Promise.all([actor.get_leaderboard(), actor.list_bots().catch(() => [])]);
    const botNames = new Map(bots.map((b) => [b.principal.toString(), b.name]));
    leaderboardBody.innerHTML = engage(renderLeaderboard(entries, plugin, { yourSid: session.sid, botNames }));
  } catch (err) {
    leaderboardBody.innerHTML = `<p class="alert">Could not load the leaderboard.</p>`;
    console.error(err);
  }
});
$("leaderboard-back").addEventListener("click", () => {
  leaderboardPanel.hidden = true;
});
