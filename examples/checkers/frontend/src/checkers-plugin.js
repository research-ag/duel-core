// GamePlugin for checkers. Candid shapes mirror ../src/CheckersRules.mo.
//
// Click-to-select: clicking one of your movable pieces selects it and
// highlights its destinations; clicking a destination finishes the move
// or, for a capture that continues, advances the selection one leg. The
// selection lives in a local `path` (`[]` = nothing selected); the
// finishing click is a real `data-act` button submitted by app.js, and
// the move generation here is a cosmetic mirror of `validate`. The board
// is flipped for Red so each player sees their own side at the bottom.
// The opponent's last move (origin, landing, captured pieces) is
// highlighted by diffing consecutive boards; State carries no move history.
// Your own move shows the moment you submit it (`applyLocal`).

import { actionAttr, esc } from "duel-game-core/render.js";

const SIZE = 8;
const DIAGS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const SEAT_NAME = { p1: "Black", p2: "Red" };
const GLYPH = { manP1: "●", kingP1: "♛", manP2: "●", kingP2: "♛" };

function idx(r, c) {
  return r * SIZE + c;
}
function rowOf(i) {
  return Math.floor(i / SIZE);
}
function colOf(i) {
  return i % SIZE;
}
function inBoard(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}
function squareLabel(i) {
  return `${String.fromCharCode(97 + colOf(i))}${SIZE - rowOf(i)}`;
}

// A Candid `opt Piece` decodes to `[] | [{ manP1: null }]`.
function pieceTagAt(board, i) {
  const cell = board[i];
  return cell && cell.length ? Object.keys(cell[0])[0] : null;
}
function ownerOfTag(tag) {
  return tag.endsWith("P1") ? "p1" : "p2";
}
function isKingTag(tag) {
  return tag.startsWith("king");
}
function forwardDelta(seat) {
  return seat === "p1" ? -1 : 1;
}

function withMove(board, from, to, tag, capturedSquare) {
  const next = board.slice();
  next[from] = [];
  if (capturedSquare !== undefined) next[capturedSquare] = [];
  next[to] = [{ [tag]: null }];
  return next;
}

function stepTargets(board, tag, i) {
  const r = rowOf(i);
  const c = colOf(i);
  const king = isKingTag(tag);
  const owner = ownerOfTag(tag);
  const out = [];
  for (const [dr, dc] of DIAGS) {
    if (!king && dr !== forwardDelta(owner)) continue;
    const nr = r + dr;
    const nc = c + dc;
    if (!inBoard(nr, nc)) continue;
    const dest = idx(nr, nc);
    if (pieceTagAt(board, dest) === null) out.push(dest);
  }
  return out;
}

// Each result is `[capturedSquare, landingSquare]`.
function jumpTargets(board, tag, i) {
  const r = rowOf(i);
  const c = colOf(i);
  const king = isKingTag(tag);
  const owner = ownerOfTag(tag);
  const out = [];
  for (const [dr, dc] of DIAGS) {
    if (!king && dr !== forwardDelta(owner)) continue;
    const lr = r + dr * 2;
    const lc = c + dc * 2;
    if (!inBoard(lr, lc)) continue;
    const mid = idx(r + dr, c + dc);
    const land = idx(lr, lc);
    if (pieceTagAt(board, land) !== null) continue;
    const victim = pieceTagAt(board, mid);
    if (victim && ownerOfTag(victim) !== owner) out.push([mid, land]);
  }
  return out;
}

function seatHasCapture(board, seat) {
  for (let i = 0; i < 64; i++) {
    const tag = pieceTagAt(board, i);
    if (tag && ownerOfTag(tag) === seat && jumpTargets(board, tag, i).length > 0) return true;
  }
  return false;
}

let path = []; // [] = nothing selected; [from, ...landingSquares] otherwise
let lastBoardKey = null;
let prevBoard = null;
let oppMove = null; // { from, to, captured: Map<square, tag> } or null

// The opponent's single move from `before` to `after`, or null when the
// boards differ in any other way (own move, new game, missed pushes).
function diffOppMove(before, after, oppSeat) {
  if (!before || before.length !== after.length) return null;
  let from = null;
  let to = null;
  const captured = new Map();
  for (let i = 0; i < after.length; i++) {
    const a = pieceTagAt(before, i);
    const b = pieceTagAt(after, i);
    if (a === b) continue;
    if (a && !b && ownerOfTag(a) === oppSeat && from === null) from = i;
    else if (a && !b && ownerOfTag(a) !== oppSeat) captured.set(i, a);
    else if (!a && b && ownerOfTag(b) === oppSeat && to === null) to = i;
    else return null;
  }
  return from !== null && to !== null ? { from, to, captured } : null;
}
let cachedBoard = null;
let cachedMySeat = null;

// The board as displayed mid-selection (piece relocated through the legs
// chosen so far; no early promotion).
function simulateBoard(board, path, tag) {
  let b = board;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k];
    const c = path[k + 1];
    const capturing = Math.abs(rowOf(c) - rowOf(a)) === 2;
    const mid = capturing ? idx((rowOf(a) + rowOf(c)) / 2, (colOf(a) + colOf(c)) / 2) : undefined;
    b = withMove(b, a, c, tag, mid);
  }
  return b;
}

// `targets` maps square -> Action if that leg finishes the move, or null
// if it only continues a capture chain.
function computeHighlights(board, mySeat) {
  const hasCapture = seatHasCapture(board, mySeat);
  const movablePieces = new Set();
  for (let i = 0; i < 64; i++) {
    const tag = pieceTagAt(board, i);
    if (!tag || ownerOfTag(tag) !== mySeat) continue;
    const moves = hasCapture ? jumpTargets(board, tag, i) : stepTargets(board, tag, i);
    if (moves.length > 0) movablePieces.add(i);
  }

  if (path.length === 0) {
    return { board, selectable: movablePieces, selected: null, targets: new Map() };
  }

  const origin = path[0];
  const tag = pieceTagAt(board, origin);
  const simBoard = simulateBoard(board, path, tag);
  const cur = path[path.length - 1];
  const targets = new Map();
  if (!hasCapture) {
    for (const dest of stepTargets(simBoard, tag, cur)) {
      targets.set(dest, { move: { from: origin, to: dest } });
    }
  } else {
    for (const [mid, land] of jumpTargets(simBoard, tag, cur)) {
      const afterBoard = withMove(simBoard, cur, land, tag, mid);
      const terminal = jumpTargets(afterBoard, tag, land).length === 0;
      targets.set(land, terminal ? { jump: { path: [...path, land] } } : null);
    }
  }
  const selectable = new Set([...movablePieces].filter((sq) => sq !== origin));
  return { board: simBoard, selectable, selected: cur, targets };
}

function drawBoard(board, highlights, flip) {
  const { selectable = new Set(), selected = null, targets = new Map() } = highlights || {};
  let cells = "";
  for (let dr = 0; dr < SIZE; dr++) {
    for (let dc = 0; dc < SIZE; dc++) {
      const r = flip ? SIZE - 1 - dr : dr;
      const c = flip ? SIZE - 1 - dc : dc;
      const i = idx(r, c);
      const dark = (r + c) % 2 === 1;
      const tag = dark ? pieceTagAt(board, i) : null;
      const classes = ["cb-square", dark ? "cb-dark" : "cb-light"];
      if (tag) classes.push("cb-piece", `cb-${ownerOfTag(tag)}`);
      if (tag && isKingTag(tag)) classes.push("cb-king");
      let glyph = tag ? GLYPH[tag] : "";
      if (oppMove && oppMove.from === i) classes.push("cb-last-from");
      if (oppMove && oppMove.to === i) classes.push("cb-last-to");
      if (oppMove && oppMove.captured.has(i)) {
        classes.push("cb-last-captured");
        if (!tag) {
          const ghost = oppMove.captured.get(i);
          classes.push(`cb-ghost-${ownerOfTag(ghost)}`);
          glyph = `<span class="cb-ghost">${GLYPH[ghost]}</span>`;
        }
      }

      let tagName = "div";
      let extraAttrs = "";
      if (selectable.has(i)) {
        classes.push("cb-selectable");
        extraAttrs = ` data-sq="${i}"`;
      } else if (selected === i) {
        classes.push("cb-selected");
        extraAttrs = ` data-sq="${i}"`;
      } else if (targets.has(i)) {
        classes.push("cb-target");
        const action = targets.get(i);
        if (action) {
          tagName = "button";
          extraAttrs = ` type="button" data-sq="${i}" ${actionAttr(action)}`;
        } else {
          extraAttrs = ` data-sq="${i}"`;
        }
      }

      cells += `<${tagName} class="${classes.join(" ")}" title="${esc(squareLabel(i))}"${extraAttrs}>${glyph}</${tagName}>`;
    }
  }
  return `<div class="cb-board">${cells}</div>`;
}

function rerenderBoard() {
  const boardEl = document.querySelector(".cb-board");
  if (!boardEl || !cachedBoard) return;
  const highlights = computeHighlights(cachedBoard, cachedMySeat);
  boardEl.outerHTML = drawBoard(highlights.board, highlights, cachedMySeat === "p2");
}

function handleSquareClick(i) {
  if (!cachedBoard) return;
  if (path.length === 0) {
    path = [i];
  } else {
    const cur = path[path.length - 1];
    if (i === cur) {
      path = []; // clicking the active piece again cancels
    } else {
      const { selectable } = computeHighlights(cachedBoard, cachedMySeat);
      path = selectable.has(i) ? [i] : [...path, i];
    }
  }
  rerenderBoard();
}

// Plain `data-sq` squares are local selection state; a `data-act` BUTTON
// square is left to app.js's own listener to submit.
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-sq]");
  if (!el || !el.closest(".cb-board")) return;
  if (el.tagName === "BUTTON") {
    path = [];
    return;
  }
  handleSquareClick(Number(el.dataset.sq));
});

export const plugin = {
  idlTypes({ IDL }) {
    const Piece = IDL.Variant({
      manP1: IDL.Null,
      manP2: IDL.Null,
      kingP1: IDL.Null,
      kingP2: IDL.Null,
    });
    const Action = IDL.Variant({
      move: IDL.Record({ from: IDL.Nat, to: IDL.Nat }),
      jump: IDL.Record({ path: IDL.Vec(IDL.Nat) }),
    });
    // Nothing is hidden: the view is the whole state.
    const View = IDL.Record({ board: IDL.Vec(IDL.Opt(Piece)), toMove: IDL.Variant({ p1: IDL.Null, p2: IDL.Null }) });
    const Options = IDL.Record({});
    return { Action, View, Options };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Resets the selection on a new board or when it isn't this seat's turn
  // (`yourTurn` is undefined for a debrief, treated as false).
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    const board = gameState.board;
    const key = JSON.stringify(board);
    if (key !== lastBoardKey) {
      lastBoardKey = key;
      path = [];
      oppMove = diffOppMove(prevBoard, board, oppSeat);
      prevBoard = board;
    }
    cachedBoard = board;
    cachedMySeat = mySeat;
    const flip = mySeat === "p2";
    if (!yourTurn) {
      path = [];
      return drawBoard(board, null, flip);
    }
    return drawBoard(board, computeHighlights(board, mySeat), flip);
  },

  renderActions() {
    return "";
  },

  // Mirrors `resolve`: every two-square leg clears its victim, and a man
  // landing on the far row is crowned.
  applyLocal(gameState, mySeat, move) {
    const steps = ("move" in move ? [move.move.from, move.move.to] : move.jump.path).map(Number);
    const tag = pieceTagAt(gameState.board, steps[0]);
    if (tag === null) return null;
    let board = gameState.board;
    for (let k = 0; k + 1 < steps.length; k++) {
      const a = steps[k];
      const b = steps[k + 1];
      const jumped = Math.abs(rowOf(b) - rowOf(a)) === 2 ? idx((rowOf(a) + rowOf(b)) / 2, (colOf(a) + colOf(b)) / 2) : undefined;
      board = withMove(board, a, b, tag, jumped);
    }
    const land = steps[steps.length - 1];
    const backRow = mySeat === "p1" ? 0 : SIZE - 1;
    if (!isKingTag(tag) && rowOf(land) === backRow) board[land] = [{ [tag.replace("man", "king")]: null }];
    return { ...gameState, board };
  },
};
