// Bootstrap for the racing duel client. Builds the actor and a
// push-shaped `ws` over it, then hands off to duel-game-core's generic
// session/render wiring for everything that's the same for every game on
// this engine (lobby, staging, rematch, debrief) — see index.html's
// #screen. It also publishes that same actor AND `ws` on
// `window.duelActorReady`/`duelWsReady` so the app's own esbuild bundle
// loaded alongside this page (see main.ts) can drive the actual 3D race
// against the identical session and the SAME poller, without building
// either a second actor or a second poll loop — see
// ../app/modules/gameplay/game-communication/utils/duel-actor.ts and
// game-communication/services/lobby-connection.service.ts.
//
// This file is bundled by esbuild (see ../build.js) into dist/duel-app.js,
// so every import below — @icp-sdk/core and duel-game-core alike —
// resolves normally from node_modules at build time and ships as one
// self-contained bundle; the deployed asset canister carries no
// node_modules directory of its own. `duel-game-core` itself is fetched
// once via `npm install` (see package.json / .npmrc) — its own dist/ is
// what these imports resolve against (its source is TypeScript; see
// ../../../../CLAUDE.md's "After touching anything under frontend/"
// section — `npm run build` there has to run BEFORE this example's own
// `npm install`, since this repo's `allow-scripts` gate blocks
// duel-game-core's own `prepare` script from doing it automatically).

import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';
import { makeIdlFactory, buildEngineTypes } from 'duel-game-core/idl.js';
import { start } from 'duel-game-core/app.js';
import { connectWs } from 'duel-game-core/ws.js';
import { resolveIdentity } from 'duel-game-core/identity.js';
import { readIcEnv, deriveHost } from 'duel-game-core/ic-env.js';
import { errText, renderLeaderboard, tag } from 'duel-game-core/render.js';
import { plugin } from './duel-racing-plugin.js';

// `window.duelActorReady` / `window.__resolveDuelActor` are set up by an
// INLINE (non-module) script in index.html's <head>, so the Promise exists
// before any deferred module script runs — the app's own bundle can then
// safely `await` it no matter which of the two loads/executes first.
if (!window.__resolveDuelActor || !window.__resolveDuelWs) {
  throw new Error("window.__resolveDuelActor/__resolveDuelWs is missing — check index.html's inline bootstrap script");
}

const env = readIcEnv();
const canisterId = env['PUBLIC_CANISTER_ID:backend'];
if (!canisterId) {
  document.body.innerHTML =
    "<p style='color:#ff7b72;padding:2rem'>Could not find " +
    '<code>PUBLIC_CANISTER_ID:backend</code> in the <code>ic_env</code> ' +
    'cookie. Serve this page from the asset canister after ' +
    '<code>icp deploy</code>.</p>';
  throw new Error('missing canister id');
}

const host = deriveHost();

// This tab's own identity — a real, permanent Internet Identity login if
// one's already active, otherwise a persisted, non-spoofable anonymous
// keypair (`duel-game-core/anon-identity.js`'s `resolveAnonymousIdentity()`,
// which `resolveIdentity()` falls back to). See duel-game-core/README.md's
// "Logging in with Internet Identity" section for the full mechanism.
//
// `ic-websocket-cdk`'s `ws_open` hard-rejects the anonymous principal
// outright ("Anonymous principal is not allowed"), so an anonymous
// session (no login) can't just build `agent` with `HttpAgent.create({
// host })` and nothing else — the WS handshake, and with it the whole
// app (there's no polling fallback), never comes up.
//
// `session.identity`'s keypair is deliberately STABLE across a reload of
// this tab (persisted in `sessionStorage`, same storage `sid` itself
// already used), and `session.sid` is derived from its own principal —
// the backend's `isAuthorizedSid` guard requires exactly this: the WS
// connection's authenticated principal must match the principal `sid`
// names, for both the anonymous and logged-in case alike. An earlier
// version of this file used a FRESH, unrelated keypair every page load
// instead, specifically to dodge a real bug in `ic-websocket-cdk@0.4.1`'s
// own bookkeeping: `remove_client` (in its `State.mo`) used to delete its
// principal->client_key lookup by PRINCIPAL ALONE, not scoped to the
// exact client_key being removed, so a belated close for an old,
// already-superseded connection could erase a newer, still-live one's
// lookup entry after a same-principal reconnect (a plain reload). That
// bug is fixed directly in the vendored CDK now (`remove_client` only
// clears the lookup when it's still the exact connection being closed),
// so a stable, sid-matching principal across reload is safe — the fresh-
// per-load workaround is no longer needed, and would in fact break
// `sid`'s own non-spoofability if reintroduced (a fresh keypair each load
// can't match a `sid` that's supposed to survive the reload).
const session = await resolveIdentity();
const agent = await HttpAgent.create({
  host,
  identity: session.identity,
  shouldFetchRootKey: /localhost|127\.0\.0\.1/.test(host),
});
const idlFactory = makeIdlFactory(plugin.idlTypes);
const actor = Actor.createActor(idlFactory, { agent, canisterId });

window.__resolveDuelActor(actor);

// A real push transport for the generic lobby/staging/rematch/debrief
// chrome below — see ../../../../../frontend/README.md's "Real-time
// push" section. connectWs() builds a GatewayWs that speaks
// mo:duel-game-core/ws's ic-websocket-cdk protocol directly,
// self-registering this tab as its own Gateway (see
// ../../../../../frontend/ws/gateway-transport.js) — genuine canister
// push, and a genuine server-side signal if this tab goes quiet.
// `principal` is the same identity `agent`/`actor` already sign calls
// with; `gameIdlTypes` supplies this game's own Action/State Candid
// shape (needed to decode the message content blob). `app.js`'s start()
// sends every action and refresh over this — there is no
// plain-actor-call/polling code path any more, `ws` is required.
//
// Published on window.duelWsReady (same pattern as the actor above) so
// lobby-connection.service.ts shares this EXACT client for the actual
// race instead of running a second independent one — `GatewayWs`
// extends EventTarget for exactly this, see its own header.
const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });
window.__resolveDuelWs(ws);

start({ plugin, ws, session });

// The leaderboard: a dedicated full-page overlay (#leaderboard-panel,
// styled `position: fixed; inset: 0` — see duel-game-core.css — and also
// hidden outright during an active race, alongside #duel-header/
// #play-vs-bot-panel, by style.css's own body.in-race rules), fetched
// fresh via a plain Candid query on the SAME actor built above
// (get_leaderboard needs no `ws` round-trip — see
// duel-game-core/README.md's "Leaderboard" section) each time it's
// opened, rather than kept live-pushed like the game screen itself.
// `plugin.formatScore` (duel-racing-plugin.js) converts each stored
// score back into a real lap time for display; `yourSid: session.sid`
// lets renderLeaderboard pick out and badge this player's own row, if
// they're on the ranked list.
const leaderboardToggle = document.getElementById('leaderboard-toggle');
const leaderboardBack = document.getElementById('leaderboard-back');
const leaderboardPanel = document.getElementById('leaderboard-panel');
const leaderboardBody = document.getElementById('leaderboard-body');
leaderboardToggle.addEventListener('click', async () => {
  leaderboardPanel.hidden = false;
  leaderboardBody.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const entries = await actor.get_leaderboard();
    leaderboardBody.innerHTML = renderLeaderboard(entries, plugin, { yourSid: session.sid });
  } catch (err) {
    leaderboardBody.innerHTML = `<p class="error">Could not load the leaderboard.</p>`;
    console.error(err);
  }
});
leaderboardBack.addEventListener('click', () => {
  leaderboardPanel.hidden = true;
});

// ── "Add Bot" — Flow 1, self-join (see ../../../../../CLAUDE.md's
// "Canister players" note) ───────────────────────────────────────────
// Once you've created a table and landed on the generic "Waiting for an
// opponent" screen (render.js's `renderStagingYou`), this lets you fill
// the OTHER seat with this deploy's own bot canister (`bot/Bot.mo`)
// instead of waiting on a second human tab. `index.html`'s
// `#play-vs-bot-panel` is a sibling of `#screen`, never touched by
// `render.js`'s own unconditional `innerHTML` replace (see the
// duel-game-core skill's rich-UI pattern) — driven here directly off the
// SAME shared `ws`/`session` the generic chrome above already uses.
//
// Unlike Flow 2 ("eager dual-seat assignment", `Registry.createTableReserving`
// — see ../../../../../backend/README.md's own section on it), this
// never touches `ws.mo`'s protocol at all: it's a PLAIN Candid call
// straight to the bot canister's own `play(host, tableId, seat, code)`
// (see `../../../bot/Bot.mo`), which then calls `host`'s
// `join_table_as_canister` on ITS OWN account — the exact same path a
// human clicking "seat open" for themselves would take, just automated.
// Flow 2 couldn't fill this role even if we wanted: it only ever
// atomically seats both sides of a BRAND NEW table in one call — it has
// no way to join an already-staged one, which is exactly this screen's
// situation (a table this player already created, with one seat still
// open).
//
// `env['PUBLIC_CANISTER_ID:bot']` comes from the same `ic_env` cookie
// `canisterId` above already reads, populated by icp-cli for every
// canister `icp.yaml` declares (this example's own `bot` canister — see
// ../../../icp.yaml) — a deploy of this frontend against a `Host.mo`
// with no `bot` canister at all (a fork that dropped it) just never sees
// this key, and the panel stays hidden for good.
const botCanisterId = env['PUBLIC_CANISTER_ID:bot'];
const playVsBotPanel = document.getElementById('play-vs-bot-panel');
const playVsBotBtn = document.getElementById('play-vs-bot');
const playVsBotErr = document.getElementById('play-vs-bot-error');
if (botCanisterId && playVsBotPanel && playVsBotBtn && playVsBotErr) {
  // A minimal, hand-written IDL for just the one bot method this page
  // calls — `buildEngineTypes` (the SAME function `idlFactory` above is
  // built from) supplies `Seat`/`TableId`/`Err` so this doesn't carry a
  // second, divergent copy of those shapes; `Action`/`State` are passed
  // as `IDL.Null` purely to satisfy that function's signature — `play`'s
  // own reply never touches either. Candid record decoding tolerates a
  // declared type naming fewer fields than the value actually carries,
  // so `JoinOk`'s own two variant arms are enough even though this page
  // never inspects a successful reply's own payload, only whether it
  // was `#ok`/`#err`.
  const botIdlFactory = ({ IDL }) => {
    const t = buildEngineTypes({ IDL, Action: IDL.Null, State: IDL.Null });
    const JoinOk = IDL.Variant({ staged: t.Seat, started: t.Seat });
    const Res = IDL.Variant({ ok: JoinOk, err: t.Err });
    return IDL.Service({
      play: IDL.Func([IDL.Principal, t.TableId, t.Seat, IDL.Opt(IDL.Text)], [Res], []),
    });
  };
  const botActor = Actor.createActor(botIdlFactory, { agent, canisterId: botCanisterId });
  const hostPrincipal = Principal.fromText(canisterId);

  // Refreshed off every status push (see below) with exactly what
  // `bot.play` needs for THIS table: the open seat (the one this session
  // ISN'T holding) and the access code, if any (`StagingYouView.visibility`
  // — known only to this table's own occupant, exactly the caller here).
  let staging = null;

  // `ws` (GatewayWs) extends EventTarget specifically so more than one
  // consumer can listen without stealing app.js's own `ws.onmessage` —
  // see the duel-game-core skill's rich-UI pattern. Shown ONLY for the
  // "Waiting for an opponent" screen specifically (not merely "at a
  // table") — browsing/busy/awaitingRematch/inGame/debrief/endedByOther
  // all hide it; `body.in-race` (style.css) additionally hides the whole
  // panel once a race actually starts, covering the one of those
  // (`inGame`) that isn't otherwise ruled out by the tag check below.
  ws.addEventListener('message', (ev) => {
    const payload = ev.data;
    if (!payload || 'err' in payload) { staging = null; playVsBotPanel.hidden = true; return; }
    const status = payload.view;
    if (!('atTable' in status) || tag(status.atTable.view) !== 'stagingYou') {
      staging = null;
      playVsBotPanel.hidden = true;
      return;
    }
    const v = status.atTable.view.stagingYou;
    staging = {
      tableId: status.atTable.id,
      openSeat: tag(v.seat) === 'p1' ? { p2: null } : { p1: null },
      code: 'code' in v.visibility ? [v.visibility.code] : [],
    };
    playVsBotPanel.hidden = false;
  });

  playVsBotBtn.addEventListener('click', async () => {
    if (playVsBotBtn.disabled || !staging) return;
    const { tableId, openSeat, code } = staging;
    playVsBotErr.hidden = true;
    playVsBotBtn.disabled = true;
    try {
      const res = await botActor.play(hostPrincipal, tableId, openSeat, code);
      if ('err' in res) {
        playVsBotErr.textContent = errText(res.err);
        playVsBotErr.hidden = false;
      }
      // On success the bot's own `join_table_as_canister` call reuses
      // `attached.afterMutation` (Host.mo) to push a fresh status to
      // THIS human's own connection in real time — app.js's own
      // `ws.onmessage` picks it up and re-renders #screen to the fresh
      // #active game on its own; nothing further to do here.
    } catch (e) {
      playVsBotErr.textContent = `Call failed: ${e && e.message ? e.message : e}`;
      playVsBotErr.hidden = false;
    } finally {
      playVsBotBtn.disabled = false;
    }
  });
}
