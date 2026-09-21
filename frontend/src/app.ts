// Generic bootstrap for any TwoPlayer-engine-backed game client.
//
// This module owns everything that's the same for every game: session
// identity, real-time push over `ws`, the generic screens (via
// render.js — the multi-table lobby, staging, rematch, busy, debrief
// chrome), and dispatching clicks back to the canister. It deliberately
// does NOT create the WebSocket-like `ws` itself — the caller builds it
// however it likes (`duel-game-core/ws.js`'s `connectWs()`, a real
// `ic-websocket-js` `IcWebSocket`, a mock for tests, ...) and hands it to
// `start()`. That keeps this package decoupled from any particular
// transport-loading strategy.
//
//   1. `sid` identifies the PLAYER, not any one game. A session id is how
//      you claim a seat at a table; open a new tab and it's automatically
//      a second player, free to create or join its own.
//   2. `status(sid)` (sent as a `#status` request over `ws`) returns a
//      per-caller `Status` — either the browsable table list, or a
//      specific table's own screen — that already encodes which screen
//      to show; see render.js's `renderStatus`.
//   3. There is exactly one transport, and no fallback: everything —
//      every action AND every refresh — goes over `ws`. `start()` never
//      calls a plain actor method itself (there is no plain mutating
//      method on the canister to call — see `../backend/src/ws.mo`'s doc
//      header) and never runs a poll loop of its own; see `ws.js`'s own
//      header for why that's still fine on the IC, which has no native
//      server push (short version: `ws.js`'s `connectWs()` builds a `ws`
//      that polls internally and hands back a WebSocket-shaped object, so
//      `start()` doesn't have to know or care that it isn't a real
//      socket).
//
// Usage:
//
//   import { connectWs } from "duel-game-core/ws.js";
//   import { start } from "duel-game-core/app.js";
//   import { resolveIdentity } from "duel-game-core/identity.js"; // or anon-identity.js
//   import { plugin } from "./my-game-plugin.js";
//
//   const session = await resolveIdentity();
//   const ws = connectWs({ actor, principal: session.principal, gameIdlTypes: plugin.idlTypes });
//   start({ plugin, ws, session });
//
// `ws` must implement the standard WebSocket-like surface (assignable
// `onopen`/`onmessage`/`onclose`/`onerror` and a `send(msg)` where `msg`
// is a plain JS object shaped like `Ws.Msg<State, Action>` — see
// idl.js) — `start()` takes ownership of the four handlers once passed
// in. If `ws` also exposes `request(sid, req) => Promise<{view}|{err}>`
// (`GatewayWs`, the transport `ws.js`'s `connectWs()` always builds,
// does — see its own doc), `start()` uses it to settle each button's own
// spinner off THAT call's own response instead of off `onmessage`'s
// shared push stream — see the "Calls" section below for why that
// distinction matters.

import {
  renderStatus,
  errText,
  tag,
  val,
  DUEL_IDLE_WARNING_ID,
  idleWarningThreshold,
  idleWarningText,
  DUEL_RECLAIM_WARNING_ID,
  RECLAIM_WARNING_SECS,
  reclaimWarningText,
  DUEL_CLAIM_WARNING_ID,
  DUEL_CLAIM_BUTTON_ID,
  claimWarningText,
  atRiskWarningText,
  claimWarningThreshold,
  waitingText,
} from "./render.js";
import type { DuelWs, EngineErr, GamePlugin, InGameView, Seat, SeatTag, StagingYouView, Visibility, WsPayload, WsRequest } from "./types.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

/// Structural equality for two decoded Candid values (Statuses, here) —
/// used to skip a redundant re-render when a push tick delivers the
/// exact same status as last time (the common case: nothing happened
/// between ticks). Not `JSON.stringify(a) === JSON.stringify(b)`: Motoko
/// `Nat`/`Int` fields decode to JS `bigint`, which `JSON.stringify`
/// throws on.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/// One `sync`-per-push, tick-every-second countdown warning — the shared
/// mechanism behind BOTH `renderInGame`'s idle-reset warning and
/// `renderStagingYou`'s reclaim warning (render.js), which face the same
/// problem: their `secondsUntilX` field is only ever as fresh as the last
/// push (nothing pushes on a bare tick of the clock — a push only ever
/// arrives off a real mutation, or off the host's periodic sweep actually
/// evicting someone; see backend/src/ws.mo's `sweepAndPush` doc), so
/// without a local tick the number sits frozen at whatever it read the
/// moment its view was last pushed instead of visibly counting down —
/// exactly the 007 defect report's finding 05 ("byte-identical from 5s
/// through 59s"). Ticks patch `elId`'s `hidden`/`textContent` directly and
/// never touch `screenEl.innerHTML` — doing that every second would
/// reintroduce exactly the hover-flicker `renderIfChanged`'s own
/// `deepEqual` short-circuit exists to avoid. A caller's own `sync(null)`
/// (wrong phase, or a phase-specific suppressed case — e.g. a player who
/// already locked in this round) stops the ticker entirely rather than
/// ticking toward a number that no longer means anything.
function makeCountdownTicker(elId: string) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: {
    secs: bigint;
    atMs: number;
    hidden: (secondsLeft: bigint) => boolean;
    text: (secondsLeft: bigint) => string;
  } | undefined;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    baseline = undefined;
  }

  function tick(): void {
    if (!baseline) return;
    // `unref()` below keeps this tolerable in Node, but the interval
    // still fires for as long as the process is alive — including after
    // a test (or any other caller that tears its own `document` mock
    // back down between runs) has already moved on. Guard the lookup
    // itself rather than assume `document` is still there to ask.
    if (typeof document === "undefined") return;
    const el = document.getElementById(elId);
    if (!el) return; // screen moved on without going through stop()
    const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - baseline.atMs) / 1000)));
    const remaining = baseline.secs > elapsed ? baseline.secs - elapsed : 0n;
    el.hidden = baseline.hidden(remaining);
    el.textContent = baseline.text(remaining);
  }

  function sync(
    next: { secs: bigint; hidden: (secondsLeft: bigint) => boolean; text: (secondsLeft: bigint) => string } | null,
  ): void {
    if (next === null) {
      stop();
      return;
    }
    baseline = { secs: next.secs, atMs: Date.now(), hidden: next.hidden, text: next.text };
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      // Node (unlike a browser) keeps a process alive for as long as a
      // timer is still pending — harmless here since this page never
      // "exits" in a browser tab, but it hangs a Node-hosted caller (a
      // test runner, an SSR pass) that outlives this instance without an
      // explicit teardown. `unref` doesn't exist on a browser's
      // `setInterval` handle at all, so this is a no-op there.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    tick();
  }

  return { sync };
}

/// Like `makeCountdownTicker`, but toggles ONLY `elId`'s `hidden`
/// attribute off a local countdown to zero — never `textContent`, so
/// it's safe to point at an element with real child markup (a button)
/// instead of a plain text node, which `makeCountdownTicker`'s own
/// `textContent` write would otherwise destroy. Exists specifically for
/// `renderInGame`'s "Claim the win" button: `View.inGame.claimWinAvailable`
/// only ever updates on a push, and nothing else causes one on a bare
/// tick of the clock (see backend/src/ws.mo's `sweepAndPush` doc) — so
/// without this, the button could stay invisible for a long time after
/// the claim window genuinely opened, even with the countdown right next
/// to it already reading "now" (a real reported bug, not hypothetical).
/// Revealing it a moment early off the LOCAL clock is harmless: the
/// engine re-validates against its own clock on the actual click and
/// simply rejects it as `#notOverdue` if it truly hasn't elapsed yet.
function makeVisibilityTicker(elId: string) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: { secs: bigint; atMs: number } | undefined;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    baseline = undefined;
  }

  function tick(): void {
    if (!baseline) return;
    if (typeof document === "undefined") return;
    const el = document.getElementById(elId);
    if (!el) return; // screen moved on without going through stop()
    const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - baseline.atMs) / 1000)));
    const remaining = baseline.secs > elapsed ? baseline.secs - elapsed : 0n;
    el.hidden = remaining > 0n;
  }

  function sync(next: { secs: bigint } | null): void {
    if (next === null) {
      stop();
      return;
    }
    baseline = { secs: next.secs, atMs: Date.now() };
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    tick();
  }

  return { sync };
}

/// Ticks every second for however many "waiting Ns" labels the open-tables
/// list (render.ts's `renderTableRow`) currently has on screen, counting
/// each one UP from its own pushed baseline — the same staleness problem
/// `makeCountdownTicker` above solves for a single countdown (a table's
/// `waitingSecs` is only ever as fresh as the last push, so left unticked
/// it sits frozen between pushes), just inverted (counting up, not down)
/// and for however many rows happen to be in `root` right now rather than
/// one fixed element id — the browsing lobby's table list can hold any
/// number of rows, appearing and disappearing between renders as tables
/// come and go, so there's no single id to key a `makeCountdownTicker` on.
/// `sync()` re-scans `root` and re-baselines every row off `Date.now()`;
/// call it once, right after `root`'s markup is (re)drawn — a redraw
/// recreates every row's element, so any baseline kept from before would
/// be patching a detached node. `tick()` only ever sets `textContent`, so
/// (like the countdown ticker above) it never fights `renderIfChanged`'s
/// `deepEqual` short-circuit for hover-state stability.
function makeTableWaitTicker(root: HTMLElement) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let rows: { el: HTMLElement; baseSecs: bigint; atMs: number }[] = [];

  function tick(): void {
    for (const row of rows) {
      const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - row.atMs) / 1000)));
      row.el.textContent = waitingText(row.baseSecs + elapsed);
    }
  }

  function sync(): void {
    rows = [...root.querySelectorAll<HTMLElement>("[data-wait-base]")].map((el) => ({
      el,
      baseSecs: BigInt(el.dataset.waitBase ?? "0"),
      atMs: Date.now(),
    }));
    if (rows.length === 0) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return;
    }
    // A row's markup already starts out textually correct (render.ts
    // wrote the same text this baseline was just read from) — but a
    // FakeElement in tests never populates `textContent` from parsed
    // markup the way a real browser would, so an immediate `tick()` here
    // both keeps that test-only surface honest and, for a real browser
    // too, guarantees this row's `atMs` baseline and its displayed text
    // agree from the very first render, not just from one second later.
    tick();
    if (timer === undefined) {
      timer = setInterval(tick, 1000);
      // See makeCountdownTicker's own comment on unref() above — same
      // Node-vs-browser rationale applies here verbatim.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  return { sync };
}

// The minimal shape `start()` itself needs from a resolved identity —
// deliberately narrower than `duel-game-core/identity.js`'s own
// `ResolvedIdentity` (which satisfies this structurally, no import
// needed) so a game that only wants `duel-game-core/anon-identity.js`'s
// lighter `resolveAnonymousIdentity()` (no `@icp-sdk/auth` dependency,
// no login/regenerate/isLoggedIn built in) can still pass its result
// straight through: `sid` is the only field `start()` strictly requires.
export interface SessionIdentity {
  sid: string;
  /// Defaults to `false` when omitted (the plain-anonymous case).
  isLoggedIn?: boolean;
  /// Present only for a session that supports it — the "new sid" button
  /// is hidden entirely (not just disabled) when this is missing, same
  /// as it already is once `isLoggedIn` is true.
  regenerate?(): Promise<void>;
  /// Wired to `authBtnId` only when BOTH are present.
  login?(): Promise<void>;
  logout?(): Promise<void>;
}

export interface StartOptions<S = unknown> {
  plugin: GamePlugin<S>;
  ws: DuelWs<S>;
  sidElId?: string;
  newSidBtnId?: string;
  screenElId?: string;
  errorElId?: string;
  // A resolved identity — `duel-game-core/identity.js`'s
  // `resolveIdentity()` (Internet Identity login, or a persisted
  // anonymous keypair) or `duel-game-core/anon-identity.js`'s lighter
  // `resolveAnonymousIdentity()` (persisted anonymous keypair only, no
  // `@icp-sdk/auth` dependency) — see this file's own "Session identity"
  // section below. Required: every legal `sid` is principal-bound (see
  // `../backend/src/ws.mo`'s `isAuthorizedSid`), so there's no longer a
  // self-generated fallback `start()` can fall back to on its own.
  session: SessionIdentity;
  authBtnId?: string;
}

/// Boots the generic session/click wiring against `ws`, using `plugin`
/// for the game-specific board and action markup.
///
/// Options (all optional except `plugin`/`ws`/`session`):
///   sidElId      - id of the element that displays the session id (default "sid")
///   newSidBtnId  - id of a "play as someone else" button (default "new-sid");
///                  auto-disabled while the current sid holds a seat, hidden
///                  entirely if `session.regenerate` isn't provided
///   screenElId   - id of the element `renderStatus` output is written into (default "screen")
///   errorElId    - id of the element transient errors are shown in (default "error")
///   ws           - WebSocket-like transport (see the file header)
///   session      - a resolved identity (see `StartOptions.session`'s own doc)
///   authBtnId    - id of a login/logout button, wired only when
///                  `session.login`/`session.logout` are both given (default "duel-auth-btn")
export function start<S>({
  plugin,
  ws,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
  session,
  authBtnId = "duel-auth-btn",
}: StartOptions<S>): void {
  if (!plugin) throw new Error("start(): `plugin` is required");
  if (!ws) throw new Error("start(): `ws` is required");
  if (!session) throw new Error("start(): `session` is required");

  // Declared up front (not down by the click listener, where the
  // original JS had it) so every closure below — including
  // beginButtonLoading/endButtonLoading, defined before the click
  // listener — can see it as definitely non-null; TS can't carry a
  // narrowing forward into a closure declared before the narrowing
  // itself. Purely a declaration-order change, not a behavioral one:
  // every one of these closures still only ever runs after start()'s own
  // synchronous body has finished.
  const screenEl = $(screenElId);
  if (!screenEl) throw new Error(`start(): no element with id "${screenElId}"`);

  // ---------------------------------------------------------------------
  // Session identity. `session.sid` is always a real, principal-bound id
  // by construction (see `SessionIdentity`'s own doc) — `start()` no
  // longer generates one itself. `sessionStorage["sid"]` still ends up
  // holding the active sid, for the same reason it always did: the one
  // place a game's own code outside `start()` (e.g. a second bundle
  // sharing the push connection) can read it from.
  //
  // "new sid" is wired only when `session.regenerate` is provided — hidden
  // entirely otherwise (not just disabled), same as it already is once
  // `session.isLoggedIn` is true: there's nothing this button could
  // meaningfully do without it. Unlike before, a click reloads the page
  // rather than swapping `sid` in place — `session.regenerate()` needs to
  // establish a freshly authenticated WS connection under the new
  // identity, and this package never tears down and rebuilds an
  // actor/ws in place (see `ResolvedIdentity.login`'s own doc on why a
  // reload is how every identity change here takes effect).
  // ---------------------------------------------------------------------

  sessionStorage.setItem("sid", session.sid);
  const sid = session.sid;
  const sidEl = $(sidElId);
  if (sidEl) sidEl.textContent = sid;
  const newSidBtn = $(newSidBtnId) as HTMLButtonElement | null;
  if (newSidBtn) {
    if (!session.regenerate || session.isLoggedIn) {
      // Not just disabled — nothing this button could do without a
      // `regenerate` hook (or for a real login, which isn't a per-tab
      // identity at all). Hidden for good; there's nothing later that
      // un-hides it (neither condition can change without a reload).
      newSidBtn.disabled = true;
      newSidBtn.hidden = true;
    } else {
      const regenerate = session.regenerate;
      newSidBtn.addEventListener("click", () => {
        if (newSidBtn.disabled) return;
        newSidBtn.disabled = true;
        regenerate().catch((e: Error) => {
          newSidBtn.disabled = false;
          showError(`New sid failed: ${e?.message ?? e}`);
        });
      });
    }
  }

  // Login/logout — wired only when both are given; left untouched
  // (whatever markup/label a game gave it, if anything) otherwise. Static
  // for the page's lifetime: logging in or out always reloads (see
  // `ResolvedIdentity.login`/`logout`'s own doc), so there's no later
  // state to re-render this against.
  const authBtn = $(authBtnId) as HTMLButtonElement | null;
  // True while THIS button's own login/logout call is in flight — checked
  // by `setNewSidDisabled` below so an unrelated re-sync (a push landing
  // mid-flight) can't re-enable it out from under its own pending action,
  // the same guard `joinPending`/`pendingButtonKey` give the rest of the
  // page's buttons.
  let authActionPending = false;
  if (authBtn && session.login && session.logout) {
    const login = session.login;
    const logout = session.logout;
    authBtn.textContent = session.isLoggedIn ? "Log out" : "Log in with Internet Identity";
    authBtn.disabled = false;
    authBtn.addEventListener("click", () => {
      if (authBtn.disabled) return;
      authActionPending = true;
      authBtn.disabled = true;
      const verb = session.isLoggedIn ? "Log out" : "Log in";
      (session.isLoggedIn ? logout() : login()).catch((e: Error) => {
        authActionPending = false;
        // Resync to whatever the shared new-sid/auth state currently is
        // instead of blindly re-enabling — e.g. a seat taken while this
        // login attempt was in flight should leave both buttons disabled.
        authBtn.disabled = newSidBtn?.disabled ?? false;
        showError(`${verb} failed: ${e?.message ?? e}`);
      });
    });
  }

  // Single choke point for "new sid"'s disabled state — also mirrors it
  // onto `authBtn` (Login/Logout), since a swapped-away-from or
  // in-progress identity is exactly as unsafe to touch mid-seat/mid-join/
  // mid-disconnect as regenerating the sid itself is. Skipped for
  // `authBtn` while its OWN action is in flight (see `authActionPending`
  // above) — that state already keeps it disabled on its own terms.
  function setNewSidDisabled(disabled: boolean): void {
    if (newSidBtn) newSidBtn.disabled = disabled;
    if (authBtn && session.login && session.logout && !authActionPending) authBtn.disabled = disabled;
  }

  // A status counts as "seated" when this sid still holds a seat at a
  // table the engine knows about (`Status.atTable` wrapping one of these
  // three inner view tags) — swapping to a fresh random sid here would
  // abandon that seat rather than free it (there's no implicit `leave` on
  // the way out), leaving the OLD sid's seat/game/debrief stuck until
  // idle takeover eventually reclaims it. `busy`/`lobby`/`endedByOther`/
  // `awaitingRematch` (at a table) and plain `browsing` (not at one at
  // all) are all sid-less in this sense — nothing of yours to abandon —
  // so only these three keep the button disabled.
  const SEATED_VIEW_TAGS = new Set(["stagingYou", "inGame", "debrief"]);

  /// Unwraps a `Status`'s `atTable` branch, or `null` while browsing (or
  /// before the first status has ever loaded).
  function atTable(status: unknown): { id: bigint; view: unknown } | null {
    if (status == null) return null;
    if (tag(status as object) !== "atTable") return null;
    return val(status as object) as { id: bigint; view: unknown };
  }

  function isSeated(status: unknown): boolean {
    const at = atTable(status);
    return at !== null && SEATED_VIEW_TAGS.has(tag(at.view as object));
  }

  /// Unwraps a `Status`'s `inGame` branch, or `null` for any other phase.
  /// Feeds `syncIdleTick`'s baseline below.
  function inGameView(status: unknown): InGameView | null {
    const at = atTable(status);
    if (at === null || tag(at.view as object) !== "inGame") return null;
    return val(at.view as object) as InGameView;
  }

  /// Same, for `stagingYou`. Feeds `syncReclaimTick`'s baseline below.
  function stagingYouView(status: unknown): StagingYouView | null {
    const at = atTable(status);
    if (at === null || tag(at.view as object) !== "stagingYou") return null;
    return val(at.view as object) as StagingYouView;
  }

  // True while THIS sid's own create/join-table call is in flight
  // (`pendingButtonKey` — declared below, see the forward-reference note
  // on `syncNewSidBtn` — is this tab's single source of truth for "which
  // of my own clicks is still waiting on a response"; only one call can
  // be in flight at a time, so there's no ambiguity). Guards new-sid
  // against being re-enabled by an UNRELATED push arriving mid-flight:
  // `ws.onmessage` runs `renderIfChanged` for every status the shared
  // push stream delivers, including periodic ticks for other players'
  // moves, not just this call's own eventual response (see `call()`'s
  // own doc) — a rival's join landing first still shows a `browsing`
  // (unseated) status to THIS sid, which would otherwise read as "safe
  // to swap identity" and re-enable the button while this sid's own
  // create/join is still pending.
  const joinPending = (): boolean =>
    pendingButtonKey !== null &&
    (pendingButtonKey.startsWith("create:") || pendingButtonKey.startsWith("jointable"));

  // Recomputes newSidBtn's disabled state off `lastStatus` (declared
  // below — fine, since every call to this happens from an event handler
  // running well after start()'s synchronous body, `lastStatus`'s
  // declaration included, has run). Used to resync after a call that
  // DIDN'T produce a new status (an error), since the click listener
  // below disables the button speculatively the moment a create/join
  // request goes out, before the engine has actually confirmed the seat.
  const syncNewSidBtn = (): void => {
    if (!newSidBtn) return;
    if (joinPending()) {
      setNewSidDisabled(true);
      return;
    }
    if (lastStatus === undefined) return;
    setNewSidDisabled(isSeated(lastStatus));
  };

  // ---------------------------------------------------------------------
  // Errors.
  // ---------------------------------------------------------------------

  let errorTimer: ReturnType<typeof setTimeout>;

  // Set for good once `ws.onclose` fires (see below) — this transport
  // instance is permanently dead at that point (GatewayWs never revives
  // the SAME instance; recovering means reloading the page for a fresh
  // ws/actor — see `showDisconnected`'s own doc), so nothing after that
  // should either show a fresh transient toast over the persistent
  // disconnected banner OR leave the board clickable. `applyLoadingState`
  // (declared below) reads this on every pass to force every button
  // disabled; `showError` reads it to stop clobbering the banner.
  let disconnected = false;

  function showError(msg: string): void {
    if (disconnected) return; // the persistent disconnected banner wins for good
    const el = $(errorElId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  // A closed transport is a fundamentally different situation from an
  // ordinary recoverable error: nothing this tab does from here on will
  // ever reach the canister again (no more pushes, no more calls), so a
  // 5-second toast that quietly hides itself — while every board button
  // stays fully clickable, each click just flashing ANOTHER misleading
  // toast ("Call failed: GatewayWs: closed") over this one — leaves a
  // dead session looking exactly like a live one. This banner stays up
  // for good instead (no `errorTimer`), and a page reload really is the
  // only way back: `start()` never owns how `ws`/`actor` were built (see
  // this file's own header), so it has no fresh connection of its own to
  // hand back — only the reload button below, a plain `location.reload()`.
  function showDisconnected(): void {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(errorTimer);
    const el = $(errorElId);
    if (el) {
      el.innerHTML = `Connection closed. <button type="button" class="ghost" id="duel-reload">Reload to reconnect</button>`;
      el.hidden = false;
      $("duel-reload")?.addEventListener("click", () => location.reload());
    }
    setNewSidDisabled(true);
    applyLoadingState();
  }

  // ---------------------------------------------------------------------
  // Calls. Every update marks `inFlight` so a stray click can't double
  // -submit.
  //
  // `GatewayWs` (the transport `ws.js` builds — see that file's header)
  // also exposes `request(sid, req)`: a Promise of THIS call's own
  // `{view}`/`{err}`, correlated to this specific submission, as opposed
  // to `send()`'s fire-and-forget message which races every other push
  // arriving on the same connection (see `ws/gateway-client.js`'s own
  // doc). `call()` prefers `request()`
  // when it's there, and settles `inFlight`/the button spinner off ITS
  // resolution — not off `ws.onmessage`, which now only renders whatever
  // status the shared push stream (periodic ticks AND every request's
  // own fetch alike) delivers next. Settling off the shared stream
  // instead clears the spinner the moment ANY unrelated periodic tick
  // lands — almost immediately, usually well before the slow update this
  // button triggered has actually resolved — and only THEN, once the
  // real response finally arrives, does the screen jump to the next
  // status: spinner gone, then a dead pause, then the switch. A caller
  // whose `ws` doesn't implement `request()` (a
  // minimal hand-rolled WebSocket, say) falls back to that same
  // send()-and-await-onmessage behavior — the best available without a
  // way to correlate a response to its own request.
  // ---------------------------------------------------------------------

  let inFlight = false;
  const canCorrelate = typeof ws.request === "function";

  // Set at the top of every `call()` dispatch (both the correlated and
  // fallback paths) so the fallback's `ws.onmessage` error branch — which,
  // unlike `settleCall`, has no Promise result to close over — can still
  // tell which request a pushed error answers. Never consulted outside an
  // error branch, so a later unrelated push (which never errors) can't
  // make it stale in a way that matters.
  let lastReq: WsRequest | null = null;

  // `Lobby.createTable`/`joinTable` reject with `#wrongPhase` when the
  // caller already has unfinished business at another table (see
  // lib.mo's `Lobby.createTable`/`joinTable` doc) — the same shape of
  // staleness the single-table engine's own bare `join` used to signal:
  // this tab's local view hasn't caught up yet (most often a fresh
  // load/reconnect that renders `browsing` before realizing this sid is
  // already seated elsewhere). A plain refresh always resolves it, so
  // treat it the same way here instead of surfacing an error the user
  // can't act on: re-send `status` and let the real status (`atTable`)
  // replace the stale one.
  function isStaleJoin(req: WsRequest | null, err: EngineErr): boolean {
    return req !== null && ("createTable" in req || "joinTable" in req) && "wrongPhase" in err;
  }

  // Mirror of isStaleJoin for `submit`/`leave`/`reset`/`claimWin`: each
  // stamps the `gen` (and, for `submit`, `turn`) it read off `lastStatus`
  // at click time (see genOf/turnOf below) — see backend/src/lib.mo's
  // `Table.gen` doc for why the engine can reject that as `#stale` instead
  // of applying it (most commonly a resend whose original attempt
  // secretly already landed, moving the match/round on before the resend
  // was processed — see ws/gateway-client.ts's `_isRetryAmbiguousError`
  // doc). Same treatment as a stale join: resync silently rather than
  // surface an error the user can't act on.
  function isStaleMutation(req: WsRequest | null, err: EngineErr): boolean {
    return (
      req !== null &&
      ("submit" in req || "leave" in req || "reset" in req || "claimWin" in req) &&
      "stale" in err
    );
  }

  // `gen`/`turn` a real client must stamp onto `submit`/`leave`/`reset` —
  // read off `lastStatus` (declared below), the single source of truth
  // this file already redraws from. A status outside a live phase (not
  // currently `atTable` at all, or `atTable` with no `gen`/`turn` of its
  // own — e.g. `browsing`, or none loaded yet) has nothing to speak of;
  // `0n` is a safe placeholder for that edge case — the engine's own
  // check just rejects it as `#stale` like any other mismatch (see
  // isStaleMutation above), never misapplies it.
  function genOf(status: unknown): bigint {
    const at = atTable(status);
    if (!at) return 0n;
    const t = tag(at.view as object);
    if (t === "stagingYou" || t === "inGame" || t === "debrief" || t === "awaitingRematch") {
      return (val(at.view as object) as { gen: bigint }).gen;
    }
    return 0n;
  }
  function turnOf(status: unknown): bigint {
    const at = atTable(status);
    if (at && tag(at.view as object) === "inGame") {
      return (val(at.view as object) as { turn: bigint }).turn;
    }
    return 0n;
  }

  function sendWs(req: WsRequest): void {
    lastReq = req;
    try {
      ws.send({ req: { sid, req } });
    } catch (e) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
      showError(`Send failed: ${(e as Error).message ?? e}`);
    }
  }

  function settleCall(req: WsRequest, payload: WsPayload<S>): void {
    inFlight = false;
    document.body.classList.remove("working");
    endButtonLoading();
    if ("err" in payload) {
      if (isStaleJoin(req, payload.err) || isStaleMutation(req, payload.err)) {
        // Resync silently instead of surfacing an error the user can't
        // act on — see isStaleJoin's/isStaleMutation's own docs.
        // `ws.onmessage` below runs its own copy of this same check,
        // since a `DuelWs` implementing `request()` is never guaranteed
        // to ALSO deliver this same payload there (`GatewayWs` happens
        // to, but nothing requires it) — so this can't assume that path
        // already fired. Both copies firing for one call (as they will,
        // for `GatewayWs`) just means two harmless, redundant `status`
        // refreshes.
        refresh();
        return;
      }
      showError(errText(payload.err));
      // A failed call never seats this sid — undo the eager disable a
      // create/join dispatch below applied speculatively (renderIfChanged,
      // which would normally resync this, only runs on the success
      // branch: an unchanged status — the common shape of a rejected
      // join, e.g. `seatTaken` — never reaches it, since it's built to
      // skip a redundant redraw off `deepEqual`, not to recompute this
      // button).
      syncNewSidBtn();
    } else {
      renderIfChanged(payload.view);
    }
  }

  function call(req: WsRequest): void {
    if (inFlight) return;
    inFlight = true;
    lastReq = req;
    document.body.classList.add("working");
    if (canCorrelate) {
      // A well-behaved `request()` (the bundled `GatewayWs`'s own) always
      // returns a promise, never throws synchronously — but `DuelWs.request`
      // is a caller-supplied surface (see this file's own header: any
      // WebSocket-shaped mock is fair game, not just `GatewayWs`), so
      // nothing here can assume that. `sendWs()` beside this guards its
      // own transport call (`ws.send`) with exactly this same shape;
      // without the matching guard here, a `request()` that threw
      // synchronously would escape uncaught, leaving `inFlight`/the
      // spinner stuck forever with no error shown at all — worse than the
      // rejection case below, which `onRejected` already handles fine.
      const onRejected = (e: Error) => {
        inFlight = false;
        document.body.classList.remove("working");
        endButtonLoading();
        showError(`Call failed: ${e.message ?? e}`);
      };
      try {
        ws.request!(sid, req).then((payload) => settleCall(req, payload), onRejected);
      } catch (e) {
        onRejected(e as Error);
      }
    } else {
      sendWs(req);
    }
  }

  const doCreateTable = (seat: SeatTag, visibility: Visibility) =>
    call({ createTable: { seat: { [seat]: null } as Seat, visibility } });
  const doJoinTable = (id: bigint, seat: SeatTag, code: [] | [string]) =>
    call({ joinTable: { id, seat: { [seat]: null } as Seat, code } });
  const doSubmit = (action: unknown) =>
    call({ submit: { gen: genOf(lastStatus), turn: turnOf(lastStatus), move: action } });
  const doRematch = () => call({ rematch: null });
  const doLeave = () => call({ leave: { gen: genOf(lastStatus) } });
  const doReset = () => call({ reset: { gen: genOf(lastStatus) } });
  const doClaimWin = () => call({ claimWin: { gen: genOf(lastStatus) } });
  const doAck = () => call({ ackEnded: null });

  // ---------------------------------------------------------------------
  // Per-button loading spinner (see style.css's `button.duel-loading`).
  // IC update calls are slow enough (hundreds of ms to a few seconds)
  // that clicking, say, a seat button with zero visual feedback until
  // the whole screen suddenly changes reads as broken/unresponsive.
  //
  // This used to snapshot the clicked BUTTON NODE itself plus every
  // sibling's disabled state, then restore/no-op off that same snapshot
  // once the call settled. That broke as soon as anything ELSE caused a
  // re-render while the call was still in flight — e.g. two players
  // clicking their own seat at once: A's join lands first, its `#status`
  // push tick reaches B's tab, and `renderIfChanged` below replaces
  // `screenEl.innerHTML` wholesale to show seat 1 now taken. That
  // recreates B's own "take seat 2" button as a brand new DOM node with
  // no `.duel-loading`/`disabled` on it — B's spinner vanishes and the
  // button looks clickable again, even though B's own join call hasn't
  // resolved yet (the cursor, driven by `body.working` below and
  // unaffected by innerHTML replacement, correctly stays busy the whole
  // time — that mismatch, spinner gone but cursor still "waiting", is
  // exactly what made this read as broken rather than just cosmetic).
  //
  // Fix: track WHICH ACTION is pending by a content key (what the button
  // *does*, from its own `dataset` — not which node happened to render
  // it), and reapply the loading/disabled look after EVERY render, not
  // just at click time. A re-render mid-flight then finds the equivalent
  // button fresh and keeps it spinning; the call's own eventual
  // settlement (`endButtonLoading`) clears the key and the very next
  // render — whether that's this call's own response or, having already
  // landed, an unrelated one already in flight — draws buttons with
  // their ordinary server-driven disabled state again.
  // ---------------------------------------------------------------------

  function buttonKey(b: HTMLButtonElement): string {
    if (b.dataset.createTable) return `create:${b.dataset.createTable}`;
    if (b.dataset.joinTable && b.dataset.joinTableId) {
      return `jointable:${b.dataset.joinTableId}:${b.dataset.joinTable}`;
    }
    if (b.dataset.act) return `act:${b.dataset.act}`;
    if ("rematch" in b.dataset) return "rematch";
    if ("leave" in b.dataset) return "leave";
    if ("reset" in b.dataset) return "reset";
    if ("claimWin" in b.dataset) return "claim-win";
    if ("ack" in b.dataset) return "ack";
    return "";
  }

  let pendingButtonKey: string | null = null;

  // Applied at click time AND after every subsequent render while a call
  // is in flight (see renderIfChanged below) — never relies on a
  // particular render having happened only once. Each button's ordinary,
  // server-driven disabled state (baked into the markup render.js just
  // produced — e.g. a seat already taken) is stashed on first sight into
  // `dataset.naturalDisabled` so it survives being forced to `true` here
  // and can be restored exactly once `pendingButtonKey` clears, without
  // needing a fresh render to happen at that exact moment.
  const applyLoadingState = (): void => {
    for (const btn of screenEl.querySelectorAll("button")) {
      const el = btn as HTMLButtonElement;
      if (el.dataset.naturalDisabled === undefined) {
        el.dataset.naturalDisabled = el.disabled ? "1" : "0";
      }
      if (disconnected) {
        // Permanent, not a `pendingButtonKey`-style spinner state: once
        // `showDisconnected` has fired there is no in-flight call to wait
        // out and no natural state to restore later, so every button —
        // including ones a stray render creates after this point — stays
        // disabled for the rest of this page's life.
        el.disabled = true;
        el.classList.remove("duel-loading");
      } else if (pendingButtonKey) {
        el.disabled = true;
        el.classList.toggle("duel-loading", buttonKey(el) === pendingButtonKey);
      } else {
        el.disabled = el.dataset.naturalDisabled === "1";
        el.classList.remove("duel-loading");
      }
    }
  };

  // Arrow-function consts, not `function` declarations — a hoisted
  // function declaration's body is, as far as TS's control flow analysis
  // is concerned, reachable from anywhere in this scope (including
  // before the `screenEl` null-guard above), so it can't carry that
  // guard's narrowing in; an expression positioned after the guard can.
  //
  // Marks `activeBtn` itself directly, in addition to going through
  // `applyLoadingState()` — belt-and-suspenders, not redundancy: this is
  // the exact node the click landed on, so marking it needs no query at
  // all and lands synchronously no matter how minimal a `screenEl` a
  // caller hands in (see e.g. the app.test.ts fake DOM, whose
  // `querySelectorAll` is a stub that never parses `innerHTML` — real
  // browsers get both paths, this one alone is what a caller like that
  // gets). `applyLoadingState()` is still what makes this survive an
  // unrelated re-render mid-flight, since by then `activeBtn` itself may
  // already be an orphaned node nobody will look at again.
  let directBtn: HTMLButtonElement | null = null;

  const beginButtonLoading = (activeBtn: HTMLButtonElement): void => {
    pendingButtonKey = buttonKey(activeBtn);
    directBtn = activeBtn;
    if (activeBtn.dataset.naturalDisabled === undefined) {
      activeBtn.dataset.naturalDisabled = activeBtn.disabled ? "1" : "0";
    }
    activeBtn.disabled = true;
    activeBtn.classList.add("duel-loading");
    applyLoadingState();
  };

  const endButtonLoading = (): void => {
    pendingButtonKey = null;
    // Symmetric undo of beginButtonLoading's own direct marking — a
    // no-op in a real DOM (applyLoadingState()'s querySelectorAll pass
    // just did the same thing) but the only restoration a caller with a
    // minimal `screenEl` (no working querySelectorAll) actually gets.
    // Skipped if the node was already thrown away by an intervening
    // re-render — nothing left to restore it TO.
    if (directBtn?.isConnected) {
      directBtn.disabled = directBtn.dataset.naturalDisabled === "1";
      directBtn.classList.remove("duel-loading");
    }
    directBtn = null;
    applyLoadingState();
  };

  // ---------------------------------------------------------------------
  // Confirmation modal, for any button marked `data-confirm="..."` (e.g.
  // render.js's Forfeit button) — built once and appended straight to
  // `<body>` rather than into `screenEl`, so it survives `refresh()`
  // replacing `screenEl.innerHTML` out from under it, and so it isn't
  // hidden if a game's own CSS makes `#screen` (or part of it)
  // click-through while overlaying its own view (see e.g.
  // examples/racing/frontend/src/style.css's `body.in-race #screen`).
  // ---------------------------------------------------------------------

  const confirmOverlay = document.createElement("div");
  confirmOverlay.className = "duel-confirm-overlay";
  confirmOverlay.hidden = true;
  confirmOverlay.innerHTML = `
    <div class="duel-confirm-box">
      <p class="duel-confirm-msg"></p>
      <div class="duel-confirm-actions">
        <button type="button" class="ghost" data-confirm-no>Cancel</button>
        <button type="button" class="primary" data-confirm-yes>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(confirmOverlay);
  const confirmMsgEl = confirmOverlay.querySelector(".duel-confirm-msg") as HTMLElement;

  let pendingConfirmed: (() => void) | null = null;

  function showConfirm(msg: string, onConfirmed: () => void): void {
    confirmMsgEl.textContent = msg;
    pendingConfirmed = onConfirmed;
    confirmOverlay.hidden = false;
  }

  function hideConfirm(): void {
    confirmOverlay.hidden = true;
    pendingConfirmed = null;
  }

  confirmOverlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === confirmOverlay || "confirmNo" in target.dataset) {
      hideConfirm();
    } else if ("confirmYes" in target.dataset) {
      const fn = pendingConfirmed;
      hideConfirm();
      if (fn) fn();
    }
  });

  // ---------------------------------------------------------------------
  // Access-code prompt, for a click on an open seat of a PROTECTED table
  // row (render.js's renderTableRow marks such a seat button with a bare
  // `data-protected`, the same idiom as `data-leave`/`data-reset`/... —
  // see its own comment). A table's own id/seat are already baked into
  // that button's dataset like any other row's seat button; only the
  // code itself is live user input this modal collects before the click
  // listener below actually dispatches `joinTable`. Same "build once,
  // append to body" shape as the confirmation modal above, for the same
  // reasons (survives `refresh()` replacing `screenEl.innerHTML`, isn't
  // hidden by a game's own click-through overlay CSS).
  // ---------------------------------------------------------------------

  const codeOverlay = document.createElement("div");
  codeOverlay.className = "duel-code-overlay";
  codeOverlay.hidden = true;
  codeOverlay.innerHTML = `
    <div class="duel-code-box">
      <p class="duel-code-msg">This table is protected — enter its access code to join.</p>
      <input type="text" class="duel-code-input" placeholder="access code" />
      <div class="duel-code-actions">
        <button type="button" class="ghost" data-code-cancel>Cancel</button>
        <button type="button" class="primary" data-code-join>Join</button>
      </div>
    </div>`;
  document.body.appendChild(codeOverlay);
  const codeInputEl = codeOverlay.querySelector(".duel-code-input") as HTMLInputElement;

  let pendingCodeSubmit: ((code: string) => void) | null = null;

  function showCodePrompt(onSubmit: (code: string) => void): void {
    codeInputEl.value = "";
    pendingCodeSubmit = onSubmit;
    codeOverlay.hidden = false;
    codeInputEl.focus?.();
  }

  function hideCodePrompt(): void {
    codeOverlay.hidden = true;
    pendingCodeSubmit = null;
  }

  codeOverlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === codeOverlay || "codeCancel" in target.dataset) {
      hideCodePrompt();
    } else if ("codeJoin" in target.dataset) {
      const fn = pendingCodeSubmit;
      const code = codeInputEl.value;
      hideCodePrompt();
      if (fn) fn(code);
    }
  });

  // ---------------------------------------------------------------------
  // The "create a table" form's visibility toggle: swaps the access-code
  // input's `hidden` state as the radio changes. A plain `change`
  // listener, delegated (like the click listener below) so it survives
  // `renderIfChanged` replacing `screenEl.innerHTML` wholesale.
  // ---------------------------------------------------------------------

  screenEl.addEventListener("change", (ev) => {
    const target = ev.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.name === "table-visibility") {
      const codeEl = $("create-code") as HTMLInputElement | null;
      if (codeEl) codeEl.hidden = target.value !== "code";
    }
  });

  /// Reads the create-table form's own current visibility choice —
  /// called at click time, not baked into any button's own `dataset`
  /// (unlike a seat, the access code is live user input render.js can't
  /// know ahead of time). An arrow-function const, not a `function`
  /// declaration — see the identical note on beginButtonLoading/
  /// endButtonLoading above for why that's what lets this see `screenEl`
  /// as definitely non-null.
  const readCreateVisibility = (): Visibility => {
    const codeChosen = (
      screenEl.querySelector('input[name="table-visibility"][value="code"]') as HTMLInputElement | null
    )?.checked;
    if (!codeChosen) return { open: null };
    const codeEl = $("create-code") as HTMLInputElement | null;
    return { code: codeEl?.value ?? "" };
  };

  // Set right before `dispatch()` runs for a protected table's seat
  // button (see below) — `dispatch` itself is a zero-argument closure
  // (shared with the plain confirm-modal flow), so the code the user just
  // typed into `showCodePrompt` has nowhere else to ride along on. Read
  // once by the `joinTable` branch below and cleared immediately after,
  // so it can never leak into an unrelated later click.
  let pendingJoinCode: string | null = null;

  // One delegated listener, so re-rendering never leaks handlers.
  screenEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const b = target.closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const dispatch = () => {
      beginButtonLoading(b);
      if (b.dataset.createTable) {
        // An empty access code is accepted by the browser's own form
        // validation (there is none) but is unreachable by construction
        // once created — see registry.mo's `createTable` doc, which
        // rejects it too; catching it here avoids the round trip and
        // gives a message that actually names the problem instead of the
        // engine's own `#badCode` (worded for a REJECTED JOIN, not a
        // table that was never creatable in the first place).
        const visibility = readCreateVisibility();
        if ("code" in visibility && visibility.code.length === 0) {
          endButtonLoading();
          showError("Enter an access code, or choose Open.");
          return;
        }
        // See the `data-join`-era comment this mirrors, below: disable
        // new-sid the moment the request goes out, not only once the
        // engine confirms the seat.
        setNewSidDisabled(true);
        doCreateTable(b.dataset.createTable as SeatTag, visibility);
      } else if (b.dataset.joinTable && b.dataset.joinTableId) {
        // A table row's own per-seat button — the id (and, for a
        // protected row, the access code just collected by
        // showCodePrompt below) is baked into its own dataset/
        // pendingJoinCode by render.js/this same listener; an open
        // table's seat never goes through pendingJoinCode at all, so it
        // stays null and sends no code, exactly as before.
        const code = pendingJoinCode;
        pendingJoinCode = null;
        setNewSidDisabled(true);
        doJoinTable(BigInt(b.dataset.joinTableId), b.dataset.joinTable as SeatTag, code ? [code] : []);
      } else if (b.dataset.act) doSubmit(JSON.parse(b.dataset.act));
      else if ("rematch" in b.dataset) doRematch();
      else if ("leave" in b.dataset) doLeave();
      else if ("reset" in b.dataset) doReset();
      else if ("claimWin" in b.dataset) doClaimWin();
      else if ("ack" in b.dataset) doAck();
    };
    if (b.dataset.confirm) showConfirm(b.dataset.confirm, dispatch);
    else if ("protected" in b.dataset) {
      // An open seat on a protected table row — collect the access code
      // before dispatching the same `joinTable` request an open row's
      // seat sends directly (see render.js's `renderTableRow`).
      showCodePrompt((code) => {
        pendingJoinCode = code;
        dispatch();
      });
    } else dispatch();
  });

  // ---------------------------------------------------------------------
  // Refresh. Sends a `#status` request — the resulting status arrives via
  // `ws.onmessage` below, same path as any other action's response.
  // Doesn't mark `inFlight`/show the "working" spinner itself (unlike
  // `call()`): this is a sync ping, not a mutating action, so there's no
  // pending user intent to guard.
  // ---------------------------------------------------------------------

  function refresh(): void {
    if (inFlight) return;
    sendWs({ status: null });
  }

  // Tracks the last status actually drawn, so a push tick that delivers
  // the SAME status (the common case — most ticks land while nothing
  // changed) can skip the redraw entirely. Replacing screenEl.innerHTML
  // destroys and recreates every button in it even when the markup is
  // byte-for-byte identical; a freshly created element under a
  // stationary cursor isn't considered `:hover` until the next mouse
  // move, so redrawing on every tick made hover states visibly blink on
  // a ~500ms cycle. See deepEqual()'s own doc for why this isn't a
  // JSON.stringify comparison.
  let lastStatus: unknown;

  // Two independent `makeCountdownTicker`s (declared above `start()`) —
  // one per warning this package renders, each keyed to its own element
  // id so patching one never touches the other.
  const idleTicker = makeCountdownTicker(DUEL_IDLE_WARNING_ID);
  const reclaimTicker = makeCountdownTicker(DUEL_RECLAIM_WARNING_ID);
  const claimTicker = makeCountdownTicker(DUEL_CLAIM_WARNING_ID);
  const claimButtonTicker = makeVisibilityTicker(DUEL_CLAIM_BUTTON_ID);
  const waitTicker = makeTableWaitTicker(screenEl);

  // Re-baselines off a FRESH `#inGame` push (a real submit/leave/etc.
  // reset the engine's own idle clock too, so this push's own
  // `secondsUntilIdleReset` is the new source of truth); stops ticking
  // entirely for any other phase — as it does for a player who's already
  // locked in this round (see render.ts's `renderInGame` doc: the warning
  // stays hidden for them regardless of how far the countdown falls, so
  // there's nothing for a tick to do until their NEXT push flips
  // `youSubmitted` back to false).
  function syncIdleTick(status: unknown): void {
    const inGame = inGameView(status);
    if (!inGame || inGame.youSubmitted) {
      idleTicker.sync(null);
      return;
    }
    idleTicker.sync({
      secs: inGame.secondsUntilIdleReset,
      hidden: (secondsLeft) => secondsLeft > idleWarningThreshold(inGame.idleTimeoutSecs),
      text: idleWarningText,
    });
  }

  // Same idea, for `#stagingYou`'s reclaim warning — re-baselines off a
  // fresh push (a seat switch or a fresh join both re-stamp `since`, so
  // this push's own `secondsUntilReclaimable` is the new source of
  // truth); stops ticking entirely for any other phase.
  function syncReclaimTick(status: unknown): void {
    const staging = stagingYouView(status);
    if (!staging) {
      reclaimTicker.sync(null);
      return;
    }
    reclaimTicker.sync({
      secs: staging.secondsUntilReclaimable,
      hidden: (secondsLeft) => secondsLeft > RECLAIM_WARNING_SECS,
      text: reclaimWarningText,
    });
  }

  // Same idea, for the claim clock — re-baselines off a fresh `#inGame`
  // push (a submit resets the engine's own idle/claim clocks too, so
  // THIS push's own `secondsUntilClaimable` is the new source of truth).
  // Drives BOTH sides of it off the exact same underlying number (see
  // render.ts's own doc on the "waiting"/"atRisk" roles): the player who
  // submitted sees their own claim countdown (and, once it elapses, the
  // button — `claimButtonTicker`, revealed locally the same way
  // `syncIdleTick` never waits for a push either); the player still
  // deciding sees the mirror-image warning that THEY could lose by
  // forfeit, with no button of their own to reveal. Stops ticking
  // entirely for any other phase, or once the round moves on and neither
  // role applies any more (both submitted — resolved already — or
  // neither has).
  function syncClaimTick(status: unknown): void {
    const inGame = inGameView(status);
    const role: "waiting" | "atRisk" | null = !inGame
      ? null
      : inGame.youSubmitted
        ? (inGame.oppSubmitted ? null : "waiting")
        : (inGame.oppSubmitted ? "atRisk" : null);
    if (!inGame || role === null) {
      claimTicker.sync(null);
      claimButtonTicker.sync(null);
      return;
    }
    const threshold = claimWarningThreshold(inGame.claimTimeoutSecs);
    claimTicker.sync({
      secs: inGame.secondsUntilClaimable,
      hidden: (secondsLeft) =>
        (role === "waiting" && secondsLeft <= 0n) || secondsLeft > threshold,
      text: role === "waiting" ? claimWarningText : atRiskWarningText,
    });
    if (role === "waiting") {
      claimButtonTicker.sync({ secs: inGame.secondsUntilClaimable });
    } else {
      claimButtonTicker.sync(null);
    }
  }

  // The create-table form's radio/code choice is plain live user input —
  // renderBrowsing() has no way to bake it into its own markup, so a
  // redraw always starts it back at its default (`open`, code blank). An
  // unrelated push (someone else's table opening or closing, e.g.)
  // landing mid-fill must not silently revert "Protected" to "Open" and
  // clear whatever code was typed — the very next click would then
  // publish a table its own creator meant to keep private, with no
  // warning at all (see the 007 retest's "a lobby refresh silently
  // discards Protected" finding). Captured right before `renderIfChanged`
  // overwrites `screenEl.innerHTML` below and reapplied right after — the
  // same idiom `applyLoadingState` already uses to survive a redraw
  // landing mid-flight, just for form input instead of a button's loading
  // state.
  interface CreateFormState {
    visibility: string; // the checked radio's own `value` ("open" or "code")
    code: string;
  }

  // Arrow-function consts, not `function` declarations — same reason as
  // beginButtonLoading/endButtonLoading above: only an expression
  // positioned after the `screenEl` null-guard carries its non-null
  // narrowing into the closure.
  const captureCreateFormState = (): CreateFormState | null => {
    const radio = screenEl.querySelector(
      'input[name="table-visibility"]:checked',
    ) as HTMLInputElement | null;
    if (!radio) return null; // not currently showing the browsing screen
    return {
      visibility: radio.value,
      code: ($("create-code") as HTMLInputElement | null)?.value ?? "",
    };
  };

  const restoreCreateFormState = (saved: CreateFormState): void => {
    // Sets BOTH radios explicitly rather than checking only the matching
    // one and relying on native same-`name` mutual exclusivity to
    // uncheck the other — the fresh markup's own default ("open",
    // statically baked into renderBrowsing()) would otherwise still read
    // as checked too once the two diverge.
    const openRadio = screenEl.querySelector(
      'input[name="table-visibility"][value="open"]',
    ) as HTMLInputElement | null;
    const codeRadio = screenEl.querySelector(
      'input[name="table-visibility"][value="code"]',
    ) as HTMLInputElement | null;
    if (!openRadio && !codeRadio) return; // the fresh render isn't the browsing screen either
    if (openRadio) openRadio.checked = saved.visibility === "open";
    if (codeRadio) codeRadio.checked = saved.visibility === "code";
    const codeEl = $("create-code") as HTMLInputElement | null;
    if (codeEl) {
      codeEl.value = saved.code;
      codeEl.hidden = saved.visibility !== "code"; // mirrors the `change` listener above
    }
  };

  const renderIfChanged = (status: unknown): void => {
    // `joinPending()` first: an unrelated push (someone else's move, a
    // table filling up, e.g.) can land mid-flight showing THIS sid still
    // unseated — that must not re-enable new-sid while this sid's own
    // create/join is still outstanding (see joinPending's own doc).
    setNewSidDisabled(joinPending() || isSeated(status));
    if (deepEqual(status, lastStatus)) return;
    lastStatus = status;
    const savedForm = captureCreateFormState();
    screenEl.innerHTML = renderStatus(status as Parameters<typeof renderStatus<S>>[0], plugin);
    if (savedForm) restoreCreateFormState(savedForm);
    syncIdleTick(status);
    syncReclaimTick(status);
    syncClaimTick(status);
    waitTicker.sync();
    // Freshly created buttons start out with whatever disabled state
    // render.js baked into the markup — reapply any still-pending
    // button's loading/disabled override on top (see applyLoadingState's
    // own doc for why this redraw can happen mid-flight, for an action
    // unrelated to the one this page is still waiting on).
    applyLoadingState();
  };

  screenEl.innerHTML = `<p class="duel-connecting">Connecting…</p>`;
  ws.onopen = () => refresh();
  ws.onmessage = (ev) => {
    const msg = ev.data;
    // A stale create/join (see isStaleJoin's own doc) is resynced right
    // here too, for every transport alike, using `lastReq` — the last
    // DISPATCHED request, since (unlike settleCall) this handler has no
    // Promise result of its own to read the request back off. For a
    // correlating transport this may fire alongside settleCall's own
    // copy of the same check (see its doc for why neither assumes the
    // other ran) — both resync silently, so at worst that's a second
    // harmless `status` round-trip, never a doubled error.
    const staleJoin = "err" in msg && isStaleJoin(lastReq, msg.err);
    const staleMutation = "err" in msg && isStaleMutation(lastReq, msg.err);

    // When `call()` can correlate its own response (see above), it
    // already settled `inFlight`/the spinner off THAT response — doing
    // it again here, off whichever message the shared push stream
    // happens to deliver next, is exactly the premature-clear this was
    // built to avoid. The fallback transport has no such signal of its
    // own, so this remains its only one — except a stale join/mutation,
    // which needs its own spinner cleared before `refresh()` below (that
    // call is a no-op while `inFlight` is still true).
    if (!canCorrelate || staleJoin || staleMutation) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
    }
    if ("err" in msg) {
      if (staleJoin || staleMutation) {
        // This sid already has unfinished business elsewhere, or its own
        // submit/leave/reset stamped a gen/turn that's since moved on —
        // refresh silently instead of surfacing an error the user can't
        // act on; the real status replaces whatever stale one led to the
        // request.
        refresh();
        return;
      }
      showError(errText(msg.err));
      // Same resync as settleCall's err branch above, for the fallback
      // transport's own error path (a rejected create/join here never
      // reaches renderIfChanged either).
      syncNewSidBtn();
    } else {
      renderIfChanged(msg.view);
    }
  };
  ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => showDisconnected();
}
