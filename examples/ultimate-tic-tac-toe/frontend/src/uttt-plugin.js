// GamePlugin for ultimate tic-tac-toe. Candid shapes mirror
// ../src/UltimateTicTacToeRules.mo. Every empty cell of a currently
// playable local board is a `data-act` button while it is your turn.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "X", p2: "O" };
const GLYPH = { p1: "✕", p2: "◯" };

function decodeOptTag(opt) {
  return opt && opt.length ? Object.keys(opt[0])[0] : null;
}
function decodeOptNat(opt) {
  return opt && opt.length ? Number(opt[0]) : null;
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
        cells += `<div class="uttt-cell uttt-mark-${mark}">${GLYPH[mark]}</div>`;
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
    const State = IDL.Record({
      cells: IDL.Vec(IDL.Opt(Seat)),
      results: IDL.Vec(IDL.Opt(BoardResult)),
      activeBoard: IDL.Opt(IDL.Nat),
    });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  renderBoard(gameState, _mySeat, _oppSeat, yourTurn) {
    return drawBoard(gameState, !!yourTurn);
  },

  renderActions() {
    return "";
  },
};
