// Bootstrap for the 007 duel client: build the actor and push transport,
// create duel-game-core's headless client, and mount 007's own UI over
// it (mission-ui.js). Nothing from `@research-ag/duel-game-core/app.js` runs here.
// Bundled by esbuild (../build.js).

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { makeIdlFactory } from "@research-ag/duel-game-core/idl.js";
import { createDuelClient } from "@research-ag/duel-game-core/client.js";
import { botPlayer, botRefOf, createBotInviter } from "@research-ag/duel-game-core/bots.js";
import { connectTransport } from "@research-ag/duel-game-core/transport.js";
import { resolveIdentity } from "@research-ag/duel-game-core/identity.js";
import { deriveHost } from "@research-ag/duel-game-core/ic-env.js";
import { botDisplayName, renderBotList, renderLeaderboard, renderSeatChoice } from "@research-ag/duel-game-core/render.js";
import { plugin } from "./duel007-plugin.js";
import { mountMissionUi } from "./mission-ui.js";

const env = safeGetCanisterEnv();
const canisterId = env?.["PUBLIC_CANISTER_ID:backend"];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    "<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> " +
    "cookie. Serve this page from the frontend canister after " +
    "<code>icp deploy</code>.</p>";
  throw new Error("missing canister id");
}

const host = deriveHost();

// An Internet Identity login if active, else a persisted anonymous keypair.
const session = await resolveIdentity();

const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  rootKey: env.IC_ROOT_KEY,
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

const transport = connectTransport({ actor, gameIdlTypes: plugin.idlTypes });

const client = createDuelClient({ transport, session });

const $ = (id) => document.getElementById(id);

// ── Bots ─────────────────────────────────────────────────────────────────
// A bot is seated by calling its own canister's `play`, never through the
// push channel. See ../../../frontend/README.md, "Bots and the leaderboard".

// `render.js` words the bot-row button "Challenge"; this game says "Engage".
const engage = (html) => html.replaceAll(">Challenge</button>", ">Engage</button>");

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

// Seats a bot through its own `play` and re-invites it on a rematch; the
// mission screen names it from the call until its join lands.
const inviter = createBotInviter({ client, play: botPlayer(agent, canisterId), storageKey: "duel007-last-bot" });
let calling = null;
let shownError = null;
inviter.subscribe(({ staging, inviting, error }) => {
  if (inviting !== null) calling = inviting;
  else if (error !== null || staging === null) calling = null;
  ui.setInviting(calling === null ? null : botDisplayName(calling.name, calling.complexity));
  if (error !== null && error !== shownError) client.showError(error);
  shownError = error;
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
  const bot = botRefOf(ev.target);
  if (!bot) return;
  botsPanel.hidden = true;
  leaderboardPanel.hidden = true;
  if (inviter.getState().staging !== null) return void inviter.challenge(bot);
  const status = client.getState().status;
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
  void inviter.challenge(challenged, seat.dataset.challengeSeat);
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
