// GamePlugin for checkers — the only game-specific piece the client
// needs. Everything else (lobby, staging, rematch, debrief chrome,
// session identity, real-time push, turn-accurate copy for an
// #alternating table) comes from the `duel-game-core` npm package's
// generic `start()`/`renderView()` — see app.js.
//
// The `Action`/`State` Candid shapes below must mirror
// `../src/CheckersRules.mo` exactly.
//
// Interaction model: click-to-select, not a flat button list. Clicking
// one of your own movable pieces selects it (unhighlighting every other
// piece and highlighting the squares it can reach); clicking one of
// those destinations either finishes the move, or — for a capture that
// can keep going — advances the selection there and highlights the NEXT
// leg, so a multi-jump chain is built up one click at a time. Clicking
// the selected piece again cancels the selection; clicking a DIFFERENT
// movable piece switches to it. All of this lives entirely in a local
// `path` variable (this module's own "selection" — `[]` = nothing
// selected, `[from, ...landingSquares]` otherwise); the actual `Action`
// submitted to the engine at the end is exactly the same
// `#move`/`#jump` shape as before, built from `path` once it's
// complete — no backend change, and `CheckersRules.mo`'s `validate` is
// still the only REAL legality gate (this is a cosmetic mirror of it,
// same as any other GamePlugin — see CLAUDE.md architecture rule 4).
// `renderBoard`'s own `yourTurn` parameter (see `GamePlugin`'s doc in
// duel-game-core/render.js) is what gates this: the board is plain and
// non-interactive whenever it isn't rendered while `yourTurn`.
//
// The board is drawn upside-down (row 7 at the top, row 0 at the
// bottom) for Black's own view and right-side-up for Red's — see
// `drawBoard`'s own `flip` — so each player always sees their own side
// at the bottom, regardless of which seat they hold.

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

// A Candid `opt Piece` decodes to `[] | [{ manP1: null }]` etc — never a
// bare object or `null` directly.
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

// A board with `from` cleared, `capturedSquare` (if any) cleared, and
// `to` occupied by `tag` — mirrors `CheckersRules.mo`'s own `setAt`
// chaining, just on the plain JS array/opt shape this file uses.
function withMove(board, from, to, tag, capturedSquare) {
  const next = board.slice();
  next[from] = [];
  if (capturedSquare !== undefined) next[capturedSquare] = [];
  next[to] = [{ [tag]: null }];
  return next;
}

// Legal one-square, non-capturing destinations for the piece at `i`.
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

// Legal one-leg captures for the piece at `i` — each result is
// `[capturedSquare, landingSquare]`.
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

// ── click-to-select state — module-level, since GamePlugin functions
//    are plain render callbacks with no state of their own to carry it
//    in ───────────────────────────────────────────────────────────────

let path = []; // [] = nothing selected; [from, ...landingSquares] otherwise
let lastBoardKey = null; // fingerprint of the last REAL board seen
let cachedBoard = null;
let cachedMySeat = null;

// Applies `path` so far to `board`, returning the board as it should be
// DISPLAYED mid-selection (the piece visually relocated through however
// many legs have already been chosen) — mirrors `CheckersRules.mo`'s
// own `resolve` loop, minus promotion (never shown early; the real
// board confirms that once the move is actually submitted).
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

// Everything `drawBoard` needs to render the CURRENT selection state:
// `board` to draw pieces from (the real one, or a mid-selection
// simulation), `selectable` (switchable-to pieces), `selected` (the
// active piece's current square, if any), and `targets` (square ->
// Action to submit if this leg finishes the move, or `null` if it just
// continues a capture chain).
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
          extraAttrs = ` type="button" ${actionAttr(action)}`;
        } else {
          extraAttrs = ` data-sq="${i}"`;
        }
      }

      cells += `<${tagName} class="${classes.join(" ")}" title="${esc(squareLabel(i))}"${extraAttrs}>${tag ? GLYPH[tag] : ""}</${tagName}>`;
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
    // Only reachable for a `data-sq` square, which with nothing selected
    // yet only ever marks a piece that's legal to select.
    path = [i];
  } else {
    const cur = path[path.length - 1];
    if (i === cur) {
      path = []; // clicking the active piece again cancels the selection
    } else {
      const { selectable } = computeHighlights(cachedBoard, cachedMySeat);
      // A different one of our own movable pieces switches the
      // selection; anything else clickable at this point can only be a
      // non-terminal capture-chain continuation.
      path = selectable.has(i) ? [i] : [...path, i];
    }
  }
  rerenderBoard();
}

// One delegated listener, registered once for the page's lifetime —
// mirrors app.ts's own `screenEl.addEventListener("click", ...)`
// pattern, just scoped to `[data-sq]` squares specifically (the plain,
// non-`data-act` ones `drawBoard` renders for select/switch/cancel/
// continue clicks). A click that lands on a `data-act` BUTTON square
// (a move- or chain-FINISHING click) is left entirely to app.ts's own
// listener to submit — this handler only resets local selection state
// so the next render (once the fresh status arrives) starts clean.
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
    const State = IDL.Record({ board: IDL.Vec(IDL.Opt(Piece)) });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Called both for a live game and for a finished debrief's final
  // state (`yourTurn` is `undefined` then — see GamePlugin's own doc —
  // which this treats the same as `false`: a finished board is never
  // clickable). Resets the local selection whenever a REAL new board
  // arrives (a move actually landed — an in-progress local selection
  // from before is stale either way) or whenever it isn't currently
  // this seat's own turn.
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    const board = gameState.board;
    const key = JSON.stringify(board);
    if (key !== lastBoardKey) {
      lastBoardKey = key;
      path = [];
    }
    cachedBoard = board;
    cachedMySeat = mySeat;
    // Black (#p1, rows 5-7) already sits at the bottom of the board's
    // own unflipped row-0-at-top orientation, so only Red (#p2, rows
    // 0-2) needs the view flipped to see their own side at the bottom.
    const flip = mySeat === "p2";
    if (!yourTurn) {
      path = [];
      return drawBoard(board, null, flip);
    }
    return drawBoard(board, computeHighlights(board, mySeat), flip);
  },

  // Everything happens by clicking the board itself (see this file's
  // own header) — no separate action panel needed.
  renderActions() {
    return "";
  },
};
