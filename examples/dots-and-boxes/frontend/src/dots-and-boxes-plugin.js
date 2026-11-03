// GamePlugin for Dots & Boxes — the only game-specific client code.
// Action/View/Options mirror ../../src/DotsAndBoxesRules.mo exactly, and
// the geometry helpers below are a cosmetic copy of that module's line
// indexing (horizontal lines first, then vertical; see its header).
//
// The board is an SVG sheet of paper: dots, pencil lines coloured by the
// seat that drew them, and a scribble over every claimed box. Undrawn
// lines are transparent `<button data-act>` hit areas laid over the SVG
// while it is this seat's turn, so a click is a real move for app.js to
// submit. New lines and boxes since the previous render animate in (a
// line draws itself, a box gets scribbled) with a pencil sound; the most
// recent line (`lastLine`) keeps a soft halo, live and on the debrief,
// so the opponent's move is never lost. `applyLocal` mirrors `resolve`
// so your own line appears the instant you click it, and `localToMove`
// lets the next line of a chain be clicked before the reply lands (the
// client sends the queued lines together).

import { actionAttr, esc } from "@research-ag/duel-game-core/render.js";
import { playFinish, playScribble, playStroke } from "./sounds.js";

const SEAT_NAME = { p1: "Blue", p2: "Red" };
const SEAT_INITIAL = { p1: "B", p2: "R" };
const SIZES = [3, 4, 5, 6];

// SVG geometry, in user units: one box is U wide, PAD frames the grid.
const U = 100;
const PAD = 24;
const HIT = 26; // thickness of a line's hit area
const HIT_INSET = 14; // keeps hit areas clear of the dots

// ── Candid helpers ──────────────────────────────────────────────────────

// `opt Seat` decodes to `[] | [{ p1: null }]`.
function seatOf(cell) {
  return cell && cell.length ? Object.keys(cell[0])[0] : null;
}
function optNat(o) {
  return o && o.length ? Number(o[0]) : null;
}
function tagOf(v) {
  return Object.keys(v)[0];
}

// ── geometry (mirrors DotsAndBoxesRules.mo) ─────────────────────────────

export function hCount(n) {
  return (n + 1) * n;
}
export function lineCount(n) {
  return 2 * n * (n + 1);
}
export function hLine(n, r, c) {
  return r * n + c;
}
export function vLine(n, r, c) {
  return hCount(n) + r * (n + 1) + c;
}
// `{ kind, r, c }` with the dot the line starts at; "h" runs right, "v" down.
export function lineAt(n, i) {
  const h = hCount(n);
  if (i < h) return { kind: "h", r: Math.floor(i / n), c: i % n };
  const j = i - h;
  return { kind: "v", r: Math.floor(j / (n + 1)), c: j % (n + 1) };
}
export function boxSides(n, b) {
  const r = Math.floor(b / n);
  const c = b % n;
  return [hLine(n, r, c), hLine(n, r + 1, c), vLine(n, r, c), vLine(n, r, c + 1)];
}
export function boxesOfLine(n, i) {
  const { kind, r, c } = lineAt(n, i);
  const out = [];
  if (kind === "h") {
    if (r > 0) out.push((r - 1) * n + c);
    if (r < n) out.push(r * n + c);
  } else {
    if (c > 0) out.push(r * n + c - 1);
    if (c < n) out.push(r * n + c);
  }
  return out;
}

// A seat's board as plain JS: sizes as numbers, cells as "p1"/"p2"/null.
function unpack(gameState) {
  const n = Number(gameState.size);
  return {
    n,
    lines: gameState.lines.map(seatOf),
    boxes: gameState.boxes.map(seatOf),
    toMove: tagOf(gameState.toMove),
    lastLine: optNat(gameState.lastLine),
  };
}

function countBoxes(boxes, seat) {
  return boxes.reduce((acc, b) => acc + (b === seat ? 1 : 0), 0);
}

// ── drawing ─────────────────────────────────────────────────────────────

// A stable per-line "hand wobble" in -4..4 so a re-render never redraws
// a line differently.
function wobble(i, salt = 0) {
  return (((i + 1) * 7919 + salt * 104729) % 9) - 4;
}

function dotXY(r, c) {
  return [PAD + c * U, PAD + r * U];
}

// A pencil line between two dots: a slightly bowed quadratic curve that
// overshoots the dots by a hair, the way a hand does.
function linePath(n, i) {
  const { kind, r, c } = lineAt(n, i);
  const [x1, y1] = dotXY(r, c);
  const [x2, y2] = kind === "h" ? dotXY(r, c + 1) : dotXY(r + 1, c);
  const over = 3;
  const w = wobble(i);
  if (kind === "h") {
    return `M ${x1 - over} ${y1 + wobble(i, 1) * 0.3} Q ${(x1 + x2) / 2} ${y1 + w} ${x2 + over} ${y2 - wobble(i, 2) * 0.3}`;
  }
  return `M ${x1 + wobble(i, 1) * 0.3} ${y1 - over} Q ${x1 + w} ${(y1 + y2) / 2} ${x2 - wobble(i, 2) * 0.3} ${y2 + over}`;
}

// A back-and-forth scribble filling box `b`.
function scribblePath(n, b) {
  const r = Math.floor(b / n);
  const c = b % n;
  const [x0, y0] = dotXY(r, c);
  const m = 16;
  const passes = 5;
  const left = x0 + m;
  const right = x0 + U - m;
  const step = (U - 2 * m) / (passes - 1);
  let d = `M ${left + wobble(b, 3)} ${y0 + m}`;
  for (let k = 0; k < passes; k++) {
    const y = y0 + m + k * step + wobble(b, k) * 0.6;
    const x = k % 2 === 0 ? right : left;
    d += ` L ${x + wobble(b, k + 7) * 0.8} ${y}`;
    if (k + 1 < passes) {
      const y2 = y0 + m + (k + 1) * step;
      d += ` L ${x + (k % 2 === 0 ? -6 : 6)} ${y2}`;
    }
  }
  return d;
}

function hitStyle(n, i) {
  const S = n * U + 2 * PAD;
  const { kind, r, c } = lineAt(n, i);
  const [x, y] = dotXY(r, c);
  let left;
  let top;
  let w;
  let h;
  if (kind === "h") {
    left = x + HIT_INSET;
    top = y - HIT / 2;
    w = U - 2 * HIT_INSET;
    h = HIT;
  } else {
    left = x - HIT / 2;
    top = y + HIT_INSET;
    w = HIT;
    h = U - 2 * HIT_INSET;
  }
  const pct = (v) => `${((v / S) * 100).toFixed(3)}%`;
  return `left:${pct(left)};top:${pct(top)};width:${pct(w)};height:${pct(h)}`;
}

function lineLabel(n, i) {
  const { kind, r, c } = lineAt(n, i);
  return kind === "h" ? `row ${r + 1}, between dots ${c + 1} and ${c + 2}` : `column ${c + 1}, between dots ${r + 1} and ${r + 2}`;
}

// ── last-render memory: what is new since the previous board ────────────

let prev = null; // { n, lines, boxes }

// Returns the sets of lines and boxes that appeared since the previous
// render of a board of the same game, and whether this is a new board.
function diffBoard(board) {
  const drawn = (lines) => lines.reduce((acc, l) => acc + (l !== null ? 1 : 0), 0);
  const sameSize = prev !== null && prev.n === board.n;
  // A line that was drawn and no longer is: a rematch (the board emptied)
  // or a rejected own move being rolled back (exactly one line gone).
  const undrawn = sameSize && prev.lines.some((l, i) => l !== null && board.lines[i] === null);
  const newGame = !sameSize || (undrawn && drawn(prev.lines) - drawn(board.lines) > 1);
  const freshLines = [];
  const freshBoxes = [];
  if (sameSize && !undrawn) {
    board.lines.forEach((l, i) => {
      if (l !== null && prev.lines[i] === null) freshLines.push(i);
    });
    board.boxes.forEach((b, i) => {
      if (b !== null && prev.boxes[i] === null) freshBoxes.push(i);
    });
    // The view keeps no draw order, only the most recent line: animate it
    // last so a burst of bot moves ends on the line that was drawn last.
    const k = freshLines.indexOf(board.lastLine);
    if (k >= 0) freshLines.push(...freshLines.splice(k, 1));
  }
  prev = { n: board.n, lines: board.lines.slice(), boxes: board.boxes.slice() };
  return { freshLines, freshBoxes, newGame };
}

function playSounds(board, { freshLines, freshBoxes }) {
  if (typeof document === "undefined") return;
  freshLines.forEach((_, k) => playStroke(k * 140));
  if (freshBoxes.length > 0) playScribble(freshLines.length * 140 + 180);
  const full = board.lines.every((l) => l !== null);
  if (full && freshLines.length > 0) playFinish(freshLines.length * 140 + 650);
}

function drawPencil(seat) {
  return `
    <svg class="dab-pencil-icon" viewBox="0 0 64 16" aria-hidden="true">
      <polygon points="0,8 10,3 10,13" class="dab-pencil-tip" />
      <polygon points="0,8 4,6 4,10" class="dab-pencil-lead" />
      <rect x="10" y="3" width="42" height="10" class="dab-pencil-body dab-${seat}" />
      <rect x="52" y="2.5" width="4" height="11" class="dab-pencil-band" />
      <rect x="56" y="3" width="8" height="10" rx="2" class="dab-pencil-eraser" />
    </svg>`;
}

function drawScore(board, mySeat, over) {
  const seats = ["p1", "p2"];
  const left = board.lines.filter((l) => l === null).length;
  return `
    <div class="dab-score">
      ${seats
        .map((seat) => {
          const on = !over && board.toMove === seat;
          return `
          <div class="dab-player dab-${seat}${on ? " dab-on" : ""}${seat === mySeat ? " dab-me" : ""}">
            ${drawPencil(seat)}
            <span class="dab-player-name">${SEAT_NAME[seat]}${seat === mySeat ? " <small>(you)</small>" : ""}</span>
            <span class="dab-player-boxes">${countBoxes(board.boxes, seat)}</span>
          </div>`;
        })
        .join("")}
      <span class="dab-left">${left === 0 ? "every line drawn" : `${left} line${left === 1 ? "" : "s"} left`}</span>
    </div>`;
}

function drawBoard(board, mySeat, yourTurn, diff) {
  const { n, lines, boxes, lastLine } = board;
  const S = n * U + 2 * PAD;
  const fresh = new Set(diff.freshLines);
  const freshBox = new Set(diff.freshBoxes);

  let boxesSvg = "";
  boxes.forEach((owner, b) => {
    if (owner === null) return;
    const r = Math.floor(b / n);
    const c = b % n;
    const [x, y] = dotXY(r, c);
    const isFresh = freshBox.has(b);
    const order = isFresh ? diff.freshBoxes.indexOf(b) : 0;
    boxesSvg += `
      <g class="dab-box dab-${owner}${isFresh ? " dab-fresh" : ""}" style="--i:${order}">
        <path class="dab-scribble" pathLength="1" d="${scribblePath(n, b)}" />
        <text class="dab-initial" x="${x + U / 2}" y="${y + U / 2 + 1}">${SEAT_INITIAL[owner]}</text>
      </g>`;
  });

  let linesSvg = "";
  lines.forEach((owner, i) => {
    if (owner === null) return;
    const d = linePath(n, i);
    const isFresh = fresh.has(i);
    const order = isFresh ? diff.freshLines.indexOf(i) : 0;
    const isLast = i === lastLine;
    if (isLast) linesSvg += `<path class="dab-halo dab-${owner}" d="${d}" />`;
    linesSvg += `<path class="dab-line dab-${owner}${isFresh ? " dab-fresh" : ""}${isLast ? " dab-last" : ""}" pathLength="1" d="${d}" style="--i:${order}"><title>${esc(
      `${SEAT_NAME[owner]} drew this${isLast ? " (latest move)" : ""}`,
    )}</title></path>`;
  });

  let dotsSvg = "";
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const [x, y] = dotXY(r, c);
      dotsSvg += `<circle class="dab-dot" cx="${x + wobble(r * 31 + c, 5) * 0.2}" cy="${y + wobble(r + c * 17, 6) * 0.2}" r="5.5" style="--i:${r * (n + 1) + c}" />`;
    }
  }

  let hits = "";
  if (yourTurn) {
    lines.forEach((owner, i) => {
      if (owner !== null) return;
      hits += `<button type="button" class="dab-hit dab-hit-${lineAt(n, i).kind}" ${actionAttr({ draw: { line: i } })} style="${hitStyle(
        n,
        i,
      )}" aria-label="Draw the line on ${esc(lineLabel(n, i))}" title="Draw this line"></button>`;
    });
  }

  return `
    <div class="dab-board${diff.newGame ? " dab-new" : ""}${yourTurn ? " dab-your-turn" : ""}" style="--n:${n}">
      <svg class="dab-sheet" viewBox="0 0 ${S} ${S}" role="img" aria-label="${n} by ${n} dots and boxes board">
        <defs>
          <filter id="dab-pencil" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="7" result="grain" />
            <feDisplacementMap in="SourceGraphic" in2="grain" scale="2.2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <g class="dab-boxes" filter="url(#dab-pencil)">${boxesSvg}</g>
        <g class="dab-lines" filter="url(#dab-pencil)">${linesSvg}</g>
        <g class="dab-dots">${dotsSvg}</g>
      </svg>
      ${hits}
    </div>`;
}

// ── the plugin ──────────────────────────────────────────────────────────

export const plugin = {
  idlTypes({ IDL }) {
    const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
    const Action = IDL.Variant({
      draw: IDL.Record({ line: IDL.Nat }),
    });
    // Nothing is hidden: the view is the whole state.
    const View = IDL.Record({
      size: IDL.Nat,
      lines: IDL.Vec(IDL.Opt(Seat)),
      boxes: IDL.Vec(IDL.Opt(Seat)),
      toMove: Seat,
      lastLine: IDL.Opt(IDL.Nat),
    });
    const Options = IDL.Record({ size: IDL.Nat });
    return { Action, View, Options };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Board sizes a creator can pick; the first is the default.
  optionChoices() {
    return SIZES.map((n) => ({ key: `size${n}`, label: `${n} × ${n}`, options: { size: BigInt(n) } }));
  },

  formatOptions(options) {
    const n = Number(options.size);
    return `${n} × ${n} boxes`;
  },

  // Called for a live game and for a debrief's final state. `yourTurn` is
  // undefined in a debrief, which draws no hit areas.
  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    const board = unpack(gameState);
    const diff = diffBoard(board);
    playSounds(board, diff);
    const over = board.lines.every((l) => l !== null);
    return drawScore(board, mySeat, over) + drawBoard(board, mySeat, yourTurn === true, diff);
  },

  // Every move lives on the board itself.
  renderActions() {
    return "";
  },

  // Mirrors `resolve`: the line gets the mover's colour, any box it closes
  // becomes theirs, and the turn stays with them only if one did.
  applyLocal(gameState, mySeat, move) {
    if (!("draw" in move)) return null;
    const line = Number(move.draw.line);
    const board = unpack(gameState);
    if (line >= board.lines.length || board.lines[line] !== null) return null;
    const lines = board.lines.slice();
    lines[line] = mySeat;
    const closed = boxesOfLine(board.n, line).filter((b) => board.boxes[b] === null && boxSides(board.n, b).every((s) => lines[s] !== null));
    const boxes = board.boxes.slice();
    for (const b of closed) boxes[b] = mySeat;
    const toMove = closed.length > 0 ? mySeat : mySeat === "p1" ? "p2" : "p1";
    const opt = (seat) => (seat === null ? [] : [{ [seat]: null }]);
    return {
      ...gameState,
      lines: lines.map(opt),
      boxes: boxes.map(opt),
      toMove: { [toMove]: null },
      lastLine: [BigInt(line)],
    };
  },

  // Whose turn the board `applyLocal` drew says it is; null once it is full.
  localToMove(gameState) {
    const board = unpack(gameState);
    return board.lines.some((l) => l === null) ? board.toMove : null;
  },
};
