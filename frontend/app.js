// Generic bootstrap for any TwoPlayer-engine-backed game client.
//
// This module owns everything that's the same for every game: session
// identity, polling `status` (or, optionally, real-time push over
// WebSocket), the generic screens (via render.js), and dispatching clicks
// back to the canister. It deliberately does NOT create the actor (or the
// WebSocket) itself — the caller builds them however it likes (esm.sh, a
// bundled `@dfinity/agent`/`ic-websocket-js`, mocks for tests, ...) and
// hands them to `start()`. That keeps this package decoupled from any
// particular agent- or transport-loading strategy.
//
//   1. `sid` identifies the PLAYER, not the game. There is ONE global
//      board; a session id is how you claim a seat on it. Keeping it in
//      sessionStorage (per-tab) means a second tab is automatically a
//      second player.
//   2. `status(sid)` returns a per-caller View that already encodes which
//      screen to show — see render.js.
//   3. The IC has no native server push, so by default this polls `status`
//      (a cheap query) on an interval. If the host canister wires
//      `mo:duel-game-core/Ws` and the caller passes `ws` (see below),
//      polling is replaced entirely by push: actions are sent over the
//      socket and the resulting view arrives the instant the canister
//      pushes it, for both players.
//
// Usage (polling — always works):
//
//   import { start } from "duel-game-core/app.js";
//   import { plugin } from "./my-game-plugin.js";
//
//   start({ actor, plugin });
//
// Usage (optional real-time push — see ../backend/README.md's "Optional:
// real-time push" section and this package's README for the full recipe):
//
//   const ws = new IcWebSocket(gatewayUrl, undefined, wsConfig); // ic-websocket-js
//   start({ actor, plugin, ws });
//
// `actor` must implement the 7-method service from idl.js:
// join/submit/rematch/leave/reset/ackEnded/status. `ws`, if given, must
// implement the standard WebSocket-like surface `ic-websocket-js`'s
// `IcWebSocket` already does: assignable `onopen`/`onmessage`/`onclose`/
// `onerror` and a `send(msg)` that candid-encodes `msg` as a
// `Ws.Msg<State, Action>` (see idl.js) — `start()` takes ownership of the
// four handlers once `ws` is passed in.

import { renderView, errText } from "./render.js";

const $ = (id) => document.getElementById(id);

function randomSid() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/// Boots the generic session/poll/click wiring against `actor`, using
/// `plugin` for the game-specific board and action markup.
///
/// Options (all optional except `actor`/`plugin`):
///   sidElId      - id of the element that displays the session id (default "sid")
///   newSidBtnId  - id of a "play as someone else" button (default "new-sid")
///   screenElId   - id of the element `renderView` output is written into (default "screen")
///   errorElId    - id of the element transient errors are shown in (default "error")
///   pollMs       - status poll interval in ms; ignored when `ws` is given (default 1000)
///   ws           - optional WebSocket transport (see the file header); when
///                  given, replaces both polling AND actor.* action calls
export function start({
  actor,
  plugin,
  ws,
  sidElId = "sid",
  newSidBtnId = "new-sid",
  screenElId = "screen",
  errorElId = "error",
  pollMs = 1000,
} = {}) {
  if (!actor) throw new Error("start(): `actor` is required");
  if (!plugin) throw new Error("start(): `plugin` is required");

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
  // Calls. Every update pauses polling, then forces a refresh so the new
  // phase lands immediately instead of on the next tick. Over `ws`, there's
  // no response to await — the canister pushes the resulting view (or a
  // rejection) back asynchronously; `ws.onmessage` below clears `inFlight`
  // when that arrives.
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

  async function call(actorFn, wsReq) {
    if (inFlight) return;
    inFlight = true;
    document.body.classList.add("working");
    if (ws) {
      sendWs(wsReq);
      return;
    }
    try {
      const res = await actorFn(sid);
      // ackEnded returns nothing; the Res-returning calls return {ok}/{err}.
      if (res && typeof res === "object" && "err" in res) {
        showError(errText(res.err));
      }
    } catch (e) {
      showError(`Call failed: ${e.message ?? e}`);
    } finally {
      inFlight = false;
      document.body.classList.remove("working");
      await refresh();
    }
  }

  const doJoin = (seat) =>
    call((s) => actor.join(s, { [seat]: null }), { join: { [seat]: null } });
  const doSubmit = (action) =>
    call((s) => actor.submit(s, action), { submit: action });
  const doRematch = () => call((s) => actor.rematch(s), { rematch: null });
  const doLeave = () => call((s) => actor.leave(s), { leave: null });
  const doReset = () => call((s) => actor.reset(s), { reset: null });
  const doAck = () => call((s) => actor.ackEnded(s), { ackEnded: null });

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
  // Refresh. Over `ws`, this SENDS a `#status` request instead of awaiting
  // one — the resulting view arrives via `ws.onmessage` below, same path as
  // any other action's response. Without `ws`, `status` is a cheap query,
  // polled on an interval; we still skip ticks while an update is in
  // flight to avoid rendering a phase about to change.
  // ---------------------------------------------------------------------

  async function refresh() {
    if (inFlight) return;
    if (ws) {
      sendWs({ status: null });
      return;
    }
    try {
      screenEl.innerHTML = renderView(await actor.status(sid), plugin);
    } catch (e) {
      showError(`Could not reach the board: ${e.message ?? e}`);
    }
  }

  if (ws) {
    screenEl.innerHTML = `<p class="duel-connecting">Connecting…</p>`;
    ws.onopen = () => refresh();
    ws.onmessage = (ev) => {
      inFlight = false;
      document.body.classList.remove("working");
      const msg = ev.data;
      if ("err" in msg) showError(errText(msg.err));
      else if ("view" in msg) screenEl.innerHTML = renderView(msg.view, plugin);
    };
    ws.onerror = (ev) => showError(`WebSocket error: ${ev?.error?.message ?? ev}`);
    ws.onclose = () => showError("Connection closed — reload to reconnect.");
  } else {
    (async function loop() {
      await refresh();
      setTimeout(loop, pollMs);
    })();
  }
}
