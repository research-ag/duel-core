// GamePlugin for checkers — the only game-specific piece the client
// needs. Everything else (lobby, staging, rematch, debrief chrome,
// session identity, real-time push, turn-accurate copy for an
// #alternating table) comes from the `duel-game-core` npm package's
// generic `start()`/`renderView()` — see app.js.
//
// The `Action`/`State` Candid shapes below must mirror
// `../src/CheckersRules.mo` exactly. `renderActions` enumerates the
// actual legal moves itself (mirroring `CheckersRules.mo`'s own
// `validate`/move-generation) and renders one button per legal move —
// see `../../../skills/duel-game-core/references/alternating-turn-games.md`
// for why a board game's `renderActions` usually takes this shape rather
// than a small fixed button set. This is a mirror only: the engine calls
// the REAL `validate` on every submission regardless of what got
// rendered here (CLAUDE.md architecture rule 4).

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

// Every maximal capture chain available starting from `start` (a piece
// of kind `tag`), as `[start, ...landingSquares]` — mirrors
// `CheckersRules.mo`'s own "must keep capturing with the same piece"
// rule: a chain only ends where no further capture is available from
// where it landed (mid-chain promotion is ignored here too, matching
// the backend).
function captureChains(board, tag, start) {
  const legs = jumpTargets(board, tag, start);
  if (legs.length === 0) return [[start]];
  const chains = [];
  for (const [mid, land] of legs) {
    const next = board.slice();
    next[start] = [];
    next[mid] = [];
    next[land] = [{ [tag]: null }];
    for (const rest of captureChains(next, tag, land)) chains.push([start, ...rest]);
  }
  return chains;
}

function legalActions(board, seat) {
  const hasCapture = seatHasCapture(board, seat);
  const actions = [];
  for (let i = 0; i < 64; i++) {
    const tag = pieceTagAt(board, i);
    if (!tag || ownerOfTag(tag) !== seat) continue;
    if (hasCapture) {
      for (const path of captureChains(board, tag, i)) {
        if (path.length > 1) actions.push({ path });
      }
    } else {
      for (const dest of stepTargets(board, tag, i)) {
        actions.push({ from: i, to: dest });
      }
    }
  }
  return actions;
}

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
  // state — a plain 8x8 grid drawn straight from `gameState.board`,
  // fixed orientation (row 0 at the top) regardless of `mySeat`.
  renderBoard(gameState, mySeat, oppSeat) {
    const board = gameState.board;
    let cells = "";
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const i = idx(r, c);
        const dark = (r + c) % 2 === 1;
        const tag = dark ? pieceTagAt(board, i) : null;
        const pieceClass = tag
          ? ` cb-piece cb-${ownerOfTag(tag)}${isKingTag(tag) ? " cb-king" : ""}`
          : "";
        cells += `<div class="cb-square ${dark ? "cb-dark" : "cb-light"}${pieceClass}" title="${esc(squareLabel(i))}">${tag ? GLYPH[tag] : ""}</div>`;
      }
    }
    return `<div class="cb-board">${cells}</div>`;
  },

  // One button per currently legal move for `mySeat` — a plain #move
  // when no capture is available, or every legal (maximal) capture
  // chain otherwise, mirroring the engine's own mandatory-capture rule.
  // `from`/`to`/`path` are plain JS numbers, not bigint: `data-act`
  // round-trips through JSON (see render.js's `actionAttr` /
  // app.js's `JSON.parse(b.dataset.act)`), which can't carry a bigint —
  // the Candid `Nat` encoder accepts a plain number just as well.
  renderActions(gameState, mySeat) {
    const actions = legalActions(gameState.board, mySeat);
    return actions
      .map((a) => {
        if ("path" in a) {
          const label = a.path.map(squareLabel).join(" ✕ ");
          return `<button ${actionAttr({ jump: { path: a.path } })}>${esc(label)}</button>`;
        }
        const label = `${squareLabel(a.from)} → ${squareLabel(a.to)}`;
        return `<button ${actionAttr({ move: { from: a.from, to: a.to } })}>${esc(label)}</button>`;
      })
      .join("");
  },
};
