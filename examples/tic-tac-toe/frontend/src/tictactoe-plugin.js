// GamePlugin for tic-tac-toe. Candid shapes mirror ../src/TicTacToeRules.mo.
// Every empty cell is a `data-act` button while it is your turn.

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

  renderBoard(gameState, _mySeat, _oppSeat, yourTurn) {
    return drawBoard(gameState.board, !!yourTurn);
  },

  renderActions() {
    return "";
  },
};
