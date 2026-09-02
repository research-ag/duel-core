// Generic view layer for any TwoPlayer-engine-backed game.
//
// `status(sid)` returns a per-caller View variant that already encodes
// which screen to show, so `renderView` is a straight switch on that tag
// — never reassemble UI policy from raw flags. Every phase except
// `inGame`/`debrief` is rendered entirely by this module; those two defer
// the board and action markup to a game-supplied `GamePlugin`:
//
//   {
//     seatLabel(seatTag) => string,                         // "White" / "Black"
//     renderBoard(gameState, mySeat, oppSeat) => htmlString,
//     renderActions(gameState, mySeat) => htmlString,        // buttons; see actionAttr()
//   }
//
// Everything in this module is a pure function to an HTML string: no
// DOM, no network, no globals. That's what makes it testable outside a
// browser, and pluggable with any move/state shape a game defines.

export const tag = (v) => Object.keys(v)[0];
export const val = (v) => Object.values(v)[0];

export function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/// Encodes an arbitrary move value into a `data-act` attribute the
/// framework's click delegation (see app.js) knows how to decode back
/// into the exact value to submit — so a game's `Action` can be any
/// Candid shape, not just a bare nullary variant.
export function actionAttr(actionValue) {
  return `data-act='${esc(JSON.stringify(actionValue))}'`;
}

/// Text for every engine-level `Err` variant. Games never need to add
/// cases here — these describe TwoPlayer's own rejections, never a
/// game's `illegalMove` reason (which the engine already returns as
/// free text from the game's own `validate`).
export function errText(e) {
  const t = tag(e);
  const v = val(e);
  switch (t) {
    case "seatTaken":
      return "That seat is already taken.";
    case "notSeated":
      return "You are not seated in this game.";
    case "alreadySubmitted":
      return "You have already moved this round.";
    case "illegalMove":
      return v;
    case "wrongPhase":
      return v;
    case "reserved":
      return `That seat is held for a rematch — ${v.secondsLeft}s left.`;
    case "notIdle":
      return `The board is in use — ${v.secondsLeft}s until it can be taken over.`;
    default:
      return t;
  }
}

function renderLobby(v, plugin) {
  const seatBtn = (seat, open) => `
    <button class="seat" data-join="${seat}" ${open ? "" : "disabled"}>
      <span class="seat-label">${esc(plugin.seatLabel(seat))}</span>
      <span class="muted">${open ? "seat open" : "taken"}</span>
    </button>`;
  return `
    <h2>Choose your seat</h2>
    <div class="seats">
      ${seatBtn("p1", v.p1Open)}
      ${seatBtn("p2", v.p2Open)}
    </div>
    ${
      v.resetAvailable
        ? `<p><button data-reset class="ghost">Clear the abandoned board</button></p>`
        : ""
    }`;
}

function renderBusy(v) {
  return `
    <h2>Board in use</h2>
    <p>Another game is under way.</p>
    <p class="countdown">${v.secondsUntilTakeover}s until it can be taken over</p>`;
}

// Once a staged (not-yet-started) seat is close to going idle, warn its own
// occupant — status()'s own #stagingYou branch never checks expiry (see
// lib.mo's comment on it), so without this a player sees a calm "Waiting
// for an opponent" right up until another tab's `join` legitimately (and
// silently, from this player's point of view) reclaims the seat — the
// engine's documented "no ghost lobbies" idle takeover, working exactly as
// designed, just with no warning attached. Quiet below the threshold so a
// normal, short wait doesn't carry a running countdown the whole time.
const RECLAIM_WARNING_SECS = 15n;

function renderReclaimWarning(secondsUntilReclaimable) {
  if (secondsUntilReclaimable > RECLAIM_WARNING_SECS) return "";
  const when =
    secondsUntilReclaimable === 0n
      ? "any moment now"
      : `in ${secondsUntilReclaimable}s`;
  return `<p class="countdown">Still there? This seat may be given to
    someone else ${when} if the page stays idle.</p>`;
}

function renderStagingYou(v, plugin) {
  const seat = tag(v.seat);
  return `
    <h2>Waiting for an opponent</h2>
    <p>You hold <strong class="seat-label">${esc(plugin.seatLabel(seat))}</strong>.</p>
    ${
      v.reservedForPartner
        ? `<p class="muted">The other seat is held for your last opponent for
             a while — after that anyone may take it.</p>`
        : `<p class="muted">Open this page in another tab to take the other
             seat.</p>`
    }
    ${renderReclaimWarning(v.secondsUntilReclaimable)}
    <p><button data-leave class="ghost">Leave</button></p>`;
}

function renderAwaitingRematch(v, plugin) {
  const seat = tag(v.openSeat);
  return `
    <h2>Rematch offered</h2>
    <p>
      Your last opponent wants another game and has held
      <strong class="seat-label">${esc(plugin.seatLabel(seat))}</strong> for you.
    </p>
    <p><button data-rematch class="primary">Accept rematch</button></p>
    <p class="muted">Ignore it and the seat opens to anyone after a while.</p>`;
}

// The Forfeit button carries `data-confirm="..."` — app.js's click
// delegation shows a confirmation modal before dispatching any button
// with that attribute, so a mid-game misclick can't hand the round to
// the opponent unintentionally. The staging/debrief `data-leave` buttons
// below (renderStagingYou/renderDebrief) deliberately don't carry it —
// leaving before a game starts or after it's already over isn't
// destructive the same way.
function renderInGame(v, plugin) {
  const mySeat = tag(v.seat);
  const oppSeat = mySeat === "p1" ? "p2" : "p1";

  return `
    <div class="turnbar">
      <span>Round <strong>${v.turn + 1n}</strong></span>
      <span class="${v.oppSubmitted ? "locked" : "muted"}">${
        v.oppSubmitted ? "◉ Opponent has locked in" : "○ Opponent is deciding"
      }</span>
    </div>
    <div class="board">${plugin.renderBoard(v.game, mySeat, oppSeat)}</div>
    ${
      v.youSubmitted
        ? `<p class="waiting">Move locked in — waiting for your opponent…</p>`
        : `<div class="actions">${plugin.renderActions(v.game, mySeat)}</div>`
    }
    <p><button data-leave data-confirm="Forfeit this game? Your opponent will win." class="ghost">Forfeit</button></p>`;
}

function renderDebrief(v, plugin) {
  const mySeat = tag(v.seat);
  const oppSeat = mySeat === "p1" ? "p2" : "p1";
  let title;
  let cls;
  if (tag(v.end) === "finished") {
    const verdict = tag(val(v.end));
    if (verdict === "draw") {
      title = "It's a draw";
      cls = "draw";
    } else if (verdict === `${mySeat}Wins`) {
      title = "You win";
      cls = "win";
    } else {
      title = "You lose";
      cls = "lose";
    }
  } else {
    title =
      tag(val(v.end)) === mySeat
        ? "You walked away"
        : "Your opponent walked away";
    cls = "draw";
  }

  return `
    <h2 class="verdict ${cls}">${title}</h2>
    <p class="muted">Game lasted ${v.turns} round${v.turns === 1n ? "" : "s"}.</p>
    <div class="board">${plugin.renderBoard(v.finalGame, mySeat, oppSeat)}</div>
    <p>
      <button data-rematch class="primary">Rematch</button>
      <button data-leave class="ghost">Return to lobby</button>
    </p>`;
}

function renderEndedByOther() {
  return `
    <h2>Your game was ended</h2>
    <p>The board went idle and someone else claimed it. Your game is gone.</p>
    <p><button data-ack class="primary">Return to lobby</button></p>`;
}

/// View -> HTML. One branch per engine phase; `inGame`/`debrief` delegate
/// the board/action markup to `plugin`.
export function renderView(view, plugin) {
  const t = tag(view);
  const v = val(view);
  switch (t) {
    case "lobby":
      return renderLobby(v, plugin);
    case "busy":
      return renderBusy(v);
    case "stagingYou":
      return renderStagingYou(v, plugin);
    case "awaitingRematch":
      return renderAwaitingRematch(v, plugin);
    case "inGame":
      return renderInGame(v, plugin);
    case "debrief":
      return renderDebrief(v, plugin);
    case "endedByOther":
      return renderEndedByOther();
    default:
      return `<p class="error">Unknown view: ${esc(t)}</p>`;
  }
}
