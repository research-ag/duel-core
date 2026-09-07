// Generic bootstrap for any TwoPlayer-engine-backed game client.
//
// This module owns everything that's the same for every game: session
// identity, real-time push over `ws`, the generic screens (via
// render.js), and dispatching clicks back to the canister. It
// deliberately does NOT create the WebSocket-like `ws` itself — the
// caller builds it however it likes (`duel-game-core/ws.js`'s
// `connectWs()`, a real `ic-websocket-js` `IcWebSocket`, a mock for
// tests, ...) and hands it to `start()`. That keeps this package
// decoupled from any particular transport-loading strategy.
//
//   1. `sid` identifies the PLAYER, not the game. There is ONE global
//      board; a session id is how you claim a seat on it. Keeping it in
//      sessionStorage (per-tab) means a second tab is automatically a
//      second player.
//   2. `status(sid)` (sent as a `#status` request over `ws`) returns a
//      per-caller View that already encodes which screen to show — see
//      render.js.
//   3. There is exactly one transport, and no fallback: everything —
//      every action AND every refresh — goes over `ws`. `start()` never
//      calls a plain actor method itself (there is no plain mutating
//      method on the canister to call — see `../backend/src/Ws.mo`'s doc
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
//   import { plugin } from "./my-game-plugin.js";
//
//   const ws = connectWs({ actor });
//   start({ plugin, ws });
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

import { renderView, errText, tag } from "./render.js";
import type { DuelWs, GamePlugin, Seat, SeatTag, WsPayload, WsRequest } from "./types.js";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function randomSid(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/// Structural equality for two decoded Candid values (Views, here) — used
/// to skip a redundant re-render when a push tick delivers the exact same
/// view as last time (the common case: nothing happened between ticks).
/// Not `JSON.stringify(a) === JSON.stringify(b)`: Motoko `Nat`/`Int`
/// fields decode to JS `bigint`, which `JSON.stringify` throws on.
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

export interface StartOptions<S = unknown> {
  plugin: GamePlugin<S>;
  ws: DuelWs<S>;
  sidElId?: string;
  newSidBtnId?: string;
  screenElId?: string;
  errorElId?: string;
}

/// Boots the generic session/click wiring against `ws`, using `plugin`
/// for the game-specific board and action markup.
///
/// Options (all optional except `plugin`/`ws`):
///   sidElId      - id of the element that displays the session id (default "sid")
///   newSidBtnId  - id of a "play as someone else" button (default "new-sid");
///                  auto-disabled while the current sid holds a seat
///   screenElId   - id of the element `renderView` output is written into (default "screen")
///   errorElId    - id of the element transient errors are shown in (default "error")
///   ws           - WebSocket-like transport (see the file header)
export function start<S>({
  plugin,
  ws,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
}: StartOptions<S>): void {
  if (!plugin) throw new Error("start(): `plugin` is required");
  if (!ws) throw new Error("start(): `ws` is required");

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
  // Session identity. sessionStorage is per-tab, so tab #2 is player #2.
  // `?sid=` wins, so you can pin an identity across reloads if you want.
  // ---------------------------------------------------------------------

  const urlSid = new URLSearchParams(location.search).get("sid");
  if (urlSid) sessionStorage.setItem("sid", urlSid);
  if (!sessionStorage.getItem("sid")) sessionStorage.setItem("sid", randomSid());

  let sid = sessionStorage.getItem("sid") as string;
  const sidEl = $(sidElId);
  if (sidEl) sidEl.textContent = sid;
  const newSidBtn = $(newSidBtnId) as HTMLButtonElement | null;
  if (newSidBtn) {
    newSidBtn.addEventListener("click", () => {
      if (newSidBtn.disabled) return;
      sid = randomSid();
      sessionStorage.setItem("sid", sid);
      if (sidEl) sidEl.textContent = sid;
      refresh();
    });
  }

  // A view tag counts as "seated" when this sid still holds a seat the
  // engine knows about — swapping to a fresh random sid here would abandon
  // that seat rather than free it (there's no implicit `leave` on the way
  // out), leaving the OLD sid's seat/game/debrief stuck until idle takeover
  // eventually reclaims it. `lobby`/`busy`/`endedByOther` are all sid-less
  // (nothing of yours to abandon) and `awaitingRematch` is an invitation
  // onto a seat you don't hold yet, not a seat of your own — so only these
  // three keep the button disabled.
  const SEATED_VIEW_TAGS = new Set(["stagingYou", "inGame", "debrief"]);

  // True while THIS sid's own join is in flight (`pendingButtonKey` —
  // declared below, see the forward-reference note on `syncNewSidBtn` —
  // is this tab's single source of truth for "which of my own clicks is
  // still waiting on a response"; only one call can be in flight at a
  // time, so there's no ambiguity). Guards new-sid against being
  // re-enabled by an UNRELATED push arriving mid-flight: `ws.onmessage`
  // runs `renderIfChanged` for every view the shared push stream
  // delivers, including periodic ticks for other players' moves, not
  // just this call's own eventual response (see `call()`'s own doc) — a
  // rival's join landing first still shows a `lobby` (unseated) view to
  // THIS sid, which would otherwise read as "safe to swap identity" and
  // re-enable the button while this sid's own join is still pending.
  const joinPending = (): boolean =>
    pendingButtonKey !== null && pendingButtonKey.startsWith("join:");

  // Recomputes newSidBtn's disabled state off `lastView` (declared below —
  // fine, since every call to this happens from an event handler running
  // well after start()'s synchronous body, `lastView`'s declaration
  // included, has run). Used to resync after a call that DIDN'T produce a
  // new view (an error), since the click listener below disables the
  // button speculatively the moment a `join` is dispatched, before the
  // engine has actually confirmed the seat.
  const syncNewSidBtn = (): void => {
    if (!newSidBtn) return;
    if (joinPending()) {
      newSidBtn.disabled = true;
      return;
    }
    if (lastView === undefined) return;
    newSidBtn.disabled = SEATED_VIEW_TAGS.has(tag(lastView as object));
  };

  // ---------------------------------------------------------------------
  // Errors.
  // ---------------------------------------------------------------------

  let errorTimer: ReturnType<typeof setTimeout>;

  function showError(msg: string): void {
    const el = $(errorElId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.hidden = true), 5000);
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
  // view the shared push stream (periodic ticks AND every request's own
  // fetch alike) delivers next. Settling off the shared stream instead
  // clears the spinner the moment ANY unrelated periodic tick lands —
  // almost immediately, usually well before the slow update this button
  // triggered has actually resolved — and only THEN, once the real
  // response finally arrives, does the screen jump to the next view:
  // spinner gone, then a dead pause, then the switch. A caller whose
  // `ws` doesn't implement `request()` (a
  // minimal hand-rolled WebSocket, say) falls back to that same
  // send()-and-await-onmessage behavior — the best available without a
  // way to correlate a response to its own request.
  // ---------------------------------------------------------------------

  let inFlight = false;
  const canCorrelate = typeof ws.request === "function";

  function sendWs(req: WsRequest): void {
    try {
      ws.send({ req: { sid, req } });
    } catch (e) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
      showError(`Send failed: ${(e as Error).message ?? e}`);
    }
  }

  function settleCall(payload: WsPayload<S>): void {
    inFlight = false;
    document.body.classList.remove("working");
    endButtonLoading();
    if ("err" in payload) {
      showError(errText(payload.err));
      // A failed call never seats this sid — undo the eager disable a
      // `join` dispatch below applied speculatively (renderIfChanged,
      // which would normally resync this, only runs on the success
      // branch: an unchanged view — the common shape of a rejected join,
      // e.g. `seatTaken` — never reaches it, since it's built to skip a
      // redundant redraw off `deepEqual`, not to recompute this button).
      syncNewSidBtn();
    } else {
      renderIfChanged(payload.view);
    }
  }

  function call(req: WsRequest): void {
    if (inFlight) return;
    inFlight = true;
    document.body.classList.add("working");
    if (canCorrelate) {
      ws.request!(sid, req).then(settleCall, (e: Error) => {
        inFlight = false;
        document.body.classList.remove("working");
        endButtonLoading();
        showError(`Call failed: ${e.message ?? e}`);
      });
    } else {
      sendWs(req);
    }
  }

  const doJoin = (seat: SeatTag) => call({ join: { [seat]: null } as Seat });
  const doSubmit = (action: unknown) => call({ submit: action });
  const doRematch = () => call({ rematch: null });
  const doLeave = () => call({ leave: null });
  const doReset = () => call({ reset: null });
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
    if (b.dataset.join) return `join:${b.dataset.join}`;
    if (b.dataset.act) return `act:${b.dataset.act}`;
    if ("rematch" in b.dataset) return "rematch";
    if ("leave" in b.dataset) return "leave";
    if ("reset" in b.dataset) return "reset";
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
      if (pendingButtonKey) {
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

  // One delegated listener, so re-rendering never leaks handlers.
  screenEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const b = target.closest("button") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const dispatch = () => {
      beginButtonLoading(b);
      if (b.dataset.join) {
        // Disable new-sid the moment a seat request goes out, not only
        // once the engine confirms it (renderIfChanged's own check, which
        // only runs on that later response) — sid is a plain module-scope
        // var, and swapping it out from under a join already in flight
        // (this join still resolves under the OLD sid, but the page now
        // displays and acts under the new one) would seat the OLD sid on
        // a seat the player can no longer reach: a soft lock, since
        // there's no way back to a sid the UI stopped tracking.
        if (newSidBtn) newSidBtn.disabled = true;
        doJoin(b.dataset.join as SeatTag);
      } else if (b.dataset.act) doSubmit(JSON.parse(b.dataset.act));
      else if ("rematch" in b.dataset) doRematch();
      else if ("leave" in b.dataset) doLeave();
      else if ("reset" in b.dataset) doReset();
      else if ("ack" in b.dataset) doAck();
    };
    if (b.dataset.confirm) showConfirm(b.dataset.confirm, dispatch);
    else dispatch();
  });

  // ---------------------------------------------------------------------
  // Refresh. Sends a `#status` request — the resulting view arrives via
  // `ws.onmessage` below, same path as any other action's response.
  // Doesn't mark `inFlight`/show the "working" spinner itself (unlike
  // `call()`): this is a sync ping, not a mutating action, so there's no
  // pending user intent to guard.
  // ---------------------------------------------------------------------

  function refresh(): void {
    if (inFlight) return;
    sendWs({ status: null });
  }

  // Tracks the last view actually drawn, so a push tick that delivers the
  // SAME view (the common case — most ticks land while nothing changed)
  // can skip the redraw entirely. Replacing screenEl.innerHTML destroys
  // and recreates every button in it even when the markup is byte-for-
  // byte identical; a freshly created element under a stationary cursor
  // isn't considered `:hover` until the next mouse move, so redrawing on
  // every tick made hover states visibly blink on a ~500ms cycle. See
  // deepEqual()'s own doc for why this isn't a JSON.stringify comparison.
  let lastView: unknown;

  const renderIfChanged = (view: unknown): void => {
    // `joinPending()` first: an unrelated push (someone else's move, e.g.)
    // can land mid-flight showing THIS sid still unseated — that must not
    // re-enable new-sid while this sid's own join is still outstanding
    // (see joinPending's own doc).
    if (newSidBtn) newSidBtn.disabled = joinPending() || SEATED_VIEW_TAGS.has(tag(view as object));
    if (deepEqual(view, lastView)) return;
    lastView = view;
    screenEl.innerHTML = renderView(view as Parameters<typeof renderView<S>>[0], plugin);
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
    // When `call()` can correlate its own response (see above), it
    // already settled `inFlight`/the spinner off THAT response — doing
    // it again here, off whichever message the shared push stream
    // happens to deliver next, is exactly the premature-clear this was
    // built to avoid. The fallback transport has no such signal of its
    // own, so this remains its only one.
    if (!canCorrelate) {
      inFlight = false;
      document.body.classList.remove("working");
      endButtonLoading();
    }
    const msg = ev.data;
    if ("err" in msg) {
      showError(errText(msg.err));
      // Same resync as settleCall's err branch above, for the fallback
      // transport's own error path (a rejected join here never reaches
      // renderIfChanged either).
      syncNewSidBtn();
    } else {
      renderIfChanged(msg.view);
    }
  };
  ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => showError("Connection closed — reload to reconnect.");
}
