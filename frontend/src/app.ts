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

import { renderView, errText } from "./render.js";
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
///   newSidBtnId  - id of a "play as someone else" button (default "new-sid")
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
  const newSidBtn = $(newSidBtnId);
  if (newSidBtn) {
    newSidBtn.addEventListener("click", () => {
      sid = randomSid();
      sessionStorage.setItem("sid", sid);
      if (sidEl) sidEl.textContent = sid;
      refresh();
    });
  }

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
    if ("err" in payload) showError(errText(payload.err));
    else renderIfChanged(payload.view);
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
  // Snapshots every button's disabled state before disabling them all
  // (not just the clicked one — a slow update in flight means every
  // other action is also illegal right now) and marks the clicked one
  // `.duel-loading`. Restoring is a no-op for any button `refresh()`'s
  // eventual re-render already threw away (`renderView` replaces
  // `screenEl.innerHTML` wholesale — see below), so it's safe to call
  // this unconditionally once a response arrives, whether or not that
  // response actually changed the view.
  // ---------------------------------------------------------------------

  let loadingSnapshot: Array<[HTMLButtonElement, boolean]> | null = null;

  // Arrow-function consts, not `function` declarations — a hoisted
  // function declaration's body is, as far as TS's control flow analysis
  // is concerned, reachable from anywhere in this scope (including
  // before the `screenEl` null-guard above), so it can't carry that
  // guard's narrowing in; an expression positioned after the guard can.
  const beginButtonLoading = (activeBtn: HTMLButtonElement): void => {
    loadingSnapshot = [...screenEl.querySelectorAll("button")].map((btn) => [
      btn,
      btn.disabled,
    ]);
    for (const [btn] of loadingSnapshot) btn.disabled = true;
    activeBtn.classList.add("duel-loading");
  };

  const endButtonLoading = (): void => {
    if (!loadingSnapshot) return;
    for (const [btn, wasDisabled] of loadingSnapshot) {
      if (!btn.isConnected) continue;
      btn.disabled = wasDisabled;
      btn.classList.remove("duel-loading");
    }
    loadingSnapshot = null;
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
      if (b.dataset.join) doJoin(b.dataset.join as SeatTag);
      else if (b.dataset.act) doSubmit(JSON.parse(b.dataset.act));
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
    if (deepEqual(view, lastView)) return;
    lastView = view;
    screenEl.innerHTML = renderView(view as Parameters<typeof renderView<S>>[0], plugin);
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
    if ("err" in msg) showError(errText(msg.err));
    else renderIfChanged(msg.view);
  };
  ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => showError("Connection closed — reload to reconnect.");
}
