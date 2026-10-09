// GamePlugin for ultimate tic-tac-toe. Candid shapes mirror
// ../src/UltimateTicTacToeRules.mo. Every empty cell of a currently
// playable local board is a `data-act` button while it is your turn; your
// mark, a local board it decides, and the routing show the moment you click
// (`applyLocal`, mirroring `resolve`). The opponent's last mark is
// highlighted by diffing consecutive boards.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "X", p2: "O" };
const GLYPH = { p1: "✕", p2: "◯" };

function decodeOptTag(opt) {
  return opt && opt.length ? Object.keys(opt[0])[0] : null;
}
function decodeOptNat(opt) {
  return opt && opt.length ? Number(opt[0]) : null;
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

let lastCellsKey = null;
let prevCells = null;
let oppLast = null; // flat index b * 9 + c, or null

// The one cell the opponent just marked, or null when the boards differ
// in any other way (own move, new game, missed pushes).
function diffOppMark(before, after, oppSeat) {
  if (!before || before.length !== after.length) return null;
  let at = null;
  for (let i = 0; i < after.length; i++) {
    const a = decodeOptTag(before[i]);
    const b = decodeOptTag(after[i]);
    if (a === b) continue;
    if (a !== null || b !== oppSeat || at !== null) return null;
    at = i;
  }
  return at;
}

function drawBoard(state, yourTurn) {
  const results = state.results.map(decodeOptTag);
  const activeBoard = decodeOptNat(state.activeBoard);

  let boards = "";
  for (let b = 0; b < 9; b++) {
    const result = results[b];
    const isRoutedHere = activeBoard === null ? result === null : activeBoard === b;

    let cells = "";
    for (let c = 0; c < 9; c++) {
      const mark = decodeOptTag(state.cells[b * 9 + c]);
      if (mark) {
        const last = b * 9 + c === oppLast ? " uttt-last" : "";
        cells += `<div class="uttt-cell uttt-mark-${mark}${last}">${GLYPH[mark]}</div>`;
      } else if (yourTurn && isRoutedHere) {
        cells += `<button type="button" class="uttt-cell uttt-empty" ${actionAttr({ place: { board: b, cell: c } })} title="board ${b + 1}, cell ${c + 1}"></button>`;
      } else {
        cells += `<div class="uttt-cell"></div>`;
      }
    }

    const overlay =
      result === "tie"
        ? `<div class="uttt-board-won uttt-board-tie">draw</div>`
        : result
          ? `<div class="uttt-board-won uttt-board-won-${result}">${GLYPH[result]}</div>`
          : "";

    const classes = ["uttt-local-board"];
    if (result) classes.push("uttt-decided");
    else if (isRoutedHere) classes.push("uttt-active");

    boards += `
      <div class="${classes.join(" ")}">
        <div class="uttt-local-grid">${cells}</div>
        ${overlay}
      </div>`;
  }
  return `<div class="uttt-meta-board">${boards}</div>`;
}

export const plugin = {
  idlTypes({ IDL }) {
    const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
    const BoardResult = IDL.Variant({ p1: IDL.Null, p2: IDL.Null, tie: IDL.Null });
    const Action = IDL.Variant({
      place: IDL.Record({ board: IDL.Nat, cell: IDL.Nat }),
    });
    // Nothing is hidden: the view is the whole state.
    const View = IDL.Record({
      cells: IDL.Vec(IDL.Opt(Seat)),
      results: IDL.Vec(IDL.Opt(BoardResult)),
      activeBoard: IDL.Opt(IDL.Nat),
    });
    const Options = IDL.Record({});
    return { Action, View, Options };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  renderBoard(gameState, _mySeat, oppSeat, yourTurn) {
    const key = JSON.stringify(gameState.cells);
    if (key !== lastCellsKey) {
      lastCellsKey = key;
      oppLast = diffOppMark(prevCells, gameState.cells, oppSeat);
      prevCells = gameState.cells;
    }
    return drawBoard(gameState, !!yourTurn);
  },

  renderActions() {
    return "";
  },

  applyLocal(gameState, mySeat, move) {
    const { board, cell } = move.place;
    const cells = gameState.cells.slice();
    cells[board * 9 + cell] = [{ [mySeat]: null }];
    const local = cells.slice(board * 9, board * 9 + 9).map(decodeOptTag);
    const won = LINES.some((line) => line.every((i) => local[i] === mySeat));
    const result = won ? mySeat : local.every((m) => m !== null) ? "tie" : null;
    const results = gameState.results.slice();
    if (result) results[board] = [{ [result]: null }];
    const activeBoard = results[cell].length ? [] : [BigInt(cell)];
    return { cells, results, activeBoard };
  },
};
