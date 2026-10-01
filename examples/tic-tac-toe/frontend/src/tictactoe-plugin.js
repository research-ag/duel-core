// GamePlugin for tic-tac-toe. Candid shapes mirror ../src/TicTacToeRules.mo.
// Every empty cell is a `data-act` button while it is your turn; your mark
// shows the moment you click (`applyLocal`). The opponent's last mark is
// highlighted by diffing consecutive boards.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "X", p2: "O" };
const GLYPH = { p1: "✕", p2: "◯" };

function markAt(board, i) {
  const cell = board[i];
  return cell && cell.length ? Object.keys(cell[0])[0] : null;
}

let lastBoardKey = null;
let prevBoard = null;
let oppLast = null;

// The one cell the opponent just marked, or null when the boards differ
// in any other way (own move, new game, missed pushes).
function diffOppMark(before, after, oppSeat) {
  if (!before) return null;
  let at = null;
  for (let i = 0; i < 9; i++) {
    const a = markAt(before, i);
    const b = markAt(after, i);
    if (a === b) continue;
    if (a !== null || b !== oppSeat || at !== null) return null;
    at = i;
  }
  return at;
}

function drawBoard(board, yourTurn) {
  let cells = "";
  for (let i = 0; i < 9; i++) {
    const mark = markAt(board, i);
    if (mark) {
      const last = i === oppLast ? " ttt-last" : "";
      cells += `<div class="ttt-square ttt-mark-${mark}${last}">${GLYPH[mark]}</div>`;
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

  renderBoard(gameState, _mySeat, oppSeat, yourTurn) {
    const board = gameState.board;
    const key = JSON.stringify(board);
    if (key !== lastBoardKey) {
      lastBoardKey = key;
      oppLast = diffOppMark(prevBoard, board, oppSeat);
      prevBoard = board;
    }
    return drawBoard(board, !!yourTurn);
  },

  renderActions() {
    return "";
  },

  applyLocal(gameState, mySeat, move) {
    const at = move.place.at;
    if (markAt(gameState.board, at) !== null) return null;
    const board = gameState.board.slice();
    board[at] = [{ [mySeat]: null }];
    return { ...gameState, board };
  },
};
