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
//   3. There is exactly one transport: everything — every action AND
//      every refresh — goes over `ws`. `start()` never calls a plain
//      actor method itself and never runs a poll loop of its own; see
//      `ws.js`'s own header for why that's still fine on the IC, which
//      has no native server push (short version: `ws.js`'s `connectWs()`
//      builds a `ws` that polls internally and hands back a
//      WebSocket-shaped object, so `start()` doesn't have to know or
//      care that it isn't a real socket).
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
// in.

import { renderView, errText } from "./render.js";

const $ = (id) => document.getElementById(id);

function randomSid() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/// Structural equality for two decoded Candid values (Views, here) — used
/// to skip a redundant re-render when a push tick delivers the exact same
/// view as last time (the common case: nothing happened between ticks).
/// Not `JSON.stringify(a) === JSON.stringify(b)`: Motoko `Nat`/`Int`
/// fields decode to JS `bigint`, which `JSON.stringify` throws on.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]),
  );
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
export function start({
  plugin,
  ws,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
} = {}) {
  if (!plugin) throw new Error("start(): `plugin` is required");
  if (!ws) throw new Error("start(): `ws` is required");

  // ---------------------------------------------------------------------
  // Session identity. sessionStorage is per-tab, so tab #2 is player #2.
  // `?sid=` wins, so you can pin an identity across reloads if you want.
  // ---------------------------------------------------------------------

  const urlSid = new URLSearchParams(location.search).get("sid");
  if (urlSid) sessionStorage.setItem("sid", urlSid);
  if (!sessionStorage.getItem("sid")) sessionStorage.setItem("sid", randomSid());

  let sid = sessionStorage.getItem("sid");
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

  let errorTimer;

  function showError(msg) {
    const el = $(errorElId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  // ---------------------------------------------------------------------
  // Calls. Every update marks `inFlight` so a stray click can't double
  // -submit — there's no response to await here — the canister pushes
  // the resulting view (or a rejection) back asynchronously over `ws`;
  // `ws.onmessage` below clears `inFlight` when that arrives.
  // ---------------------------------------------------------------------

  let inFlight = false;

  function sendWs(req) {
    try {
      ws.send({ req: { sid, req } });
    } catch (e) {
      inFlight = false;
      document.body.classList.remove("working");
      showError(`Send failed: ${e.message ?? e}`);
    }
  }

  function call(req) {
    if (inFlight) return;
    inFlight = true;
    document.body.classList.add("working");
    sendWs(req);
  }

  const doJoin = (seat) => call({ join: { [seat]: null } });
  const doSubmit = (action) => call({ submit: action });
  const doRematch = () => call({ rematch: null });
  const doLeave = () => call({ leave: null });
  const doReset = () => call({ reset: null });
  const doAck = () => call({ ackEnded: null });

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
  const confirmMsgEl = confirmOverlay.querySelector(".duel-confirm-msg");

  let pendingConfirmed = null;

  function showConfirm(msg, onConfirmed) {
    confirmMsgEl.textContent = msg;
    pendingConfirmed = onConfirmed;
    confirmOverlay.hidden = false;
  }

  function hideConfirm() {
    confirmOverlay.hidden = true;
    pendingConfirmed = null;
  }

  confirmOverlay.addEventListener("click", (ev) => {
    if (ev.target === confirmOverlay || "confirmNo" in ev.target.dataset) {
      hideConfirm();
    } else if ("confirmYes" in ev.target.dataset) {
      const fn = pendingConfirmed;
      hideConfirm();
      if (fn) fn();
    }
  });

  // One delegated listener, so re-rendering never leaks handlers.
  const screenEl = $(screenElId);
  screenEl.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.disabled) return;
    const dispatch = () => {
      if (b.dataset.join) doJoin(b.dataset.join);
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

  function refresh() {
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
  let lastView;

  screenEl.innerHTML = `<p class="duel-connecting">Connecting…</p>`;
  ws.onopen = () => refresh();
  ws.onmessage = (ev) => {
    inFlight = false;
    document.body.classList.remove("working");
    const msg = ev.data;
    if ("err" in msg) {
      showError(errText(msg.err));
    } else if ("view" in msg && !deepEqual(msg.view, lastView)) {
      lastView = msg.view;
      screenEl.innerHTML = renderView(msg.view, plugin);
    }
  };
  ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
  ws.onclose = () => showError("Connection closed — reload to reconnect.");
}
