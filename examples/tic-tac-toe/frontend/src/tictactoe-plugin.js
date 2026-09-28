// GamePlugin for tic-tac-toe — the only game-specific piece the client
// needs. Everything else (the multi-table lobby, staging, rematch,
// debrief chrome, session identity, real-time push, turn-accurate copy
// for an #alternating table) comes from the `duel-game-core` npm
// package's generic `start()`/`renderView()` — see app.js.
//
// The `Action`/`State` Candid shapes below must mirror
// `../src/TicTacToeRules.mo` exactly.
//
// Interaction model: click any empty cell to place your mark there —
// unlike checkers, a tic-tac-toe move is never more than one cell, so
// there's no multi-step selection state to track; every empty cell is
// rendered directly as a real `<button data-act=...>` (`actionAttr()`),
// submitted unchanged the instant it's clicked. `renderActions` returns
// nothing (an empty string) — everything happens by clicking the board,
// same as `examples/checkers/frontend/src/checkers-plugin.js`.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "X", p2: "O" };
const GLYPH = { p1: "✕", p2: "◯" };

function drawBoard(board, yourTurn) {
  let cells = "";
  for (let i = 0; i < 9; i++) {
    const cell = board[i];
    const mark = cell && cell.length ? Object.keys(cell[0])[0] : null;
    if (mark) {
      cells += `<div class="ttt-square ttt-mark-${mark}">${GLYPH[mark]}</div>`;
    } else if (yourTurn) {
      cells += `<button type="button" class="ttt-square ttt-empty" ${actionAttr({ place: { at: i } })} title="${esc(String(i))}"></button>`;
    } else {
      cells += `<div class="ttt-square"></div>`;
    }
  }
  return `<div class="ttt-board">${cells}</div>`;
}

export const plugin = {
  idlTypes({ IDL }) {
    const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
    const Action = IDL.Variant({
      place: IDL.Record({ at: IDL.Nat }),
    });
    const State = IDL.Record({ board: IDL.Vec(IDL.Opt(Seat)) });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Called both for a live game (yourTurn set) and for a finished
  // debrief's final state (yourTurn is `undefined` then — see
  // GamePlugin's own doc — treated the same as `false`: a finished board
  // is never clickable).
  renderBoard(gameState, _mySeat, _oppSeat, yourTurn) {
    return drawBoard(gameState.board, !!yourTurn);
  },

  // Everything happens by clicking the board itself — no separate action
  // panel needed.
  renderActions() {
    return "";
  },
};
