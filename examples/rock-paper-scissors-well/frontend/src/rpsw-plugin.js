// GamePlugin for rock-paper-scissors-well — the only game-specific piece
// the client needs. Everything else (the multi-table lobby, staging,
// rematch, debrief chrome, session identity, real-time push) comes from
// the duel-game-core npm package's generic start()/renderView() — see
// app.js. The Action/State Candid shapes here must mirror
// ../src/RockPaperScissorsWellRules.mo exactly. `legal()` below is a
// COSMETIC echo of that module's `validate` (disabled buttons only —
// every pick is always legal, so nothing is ever disabled; the server is
// the only real legality gate regardless, CLAUDE.md architecture rule 4).

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "Player 1", p2: "Player 2" };
const GLYPH = { rock: "🪨", paper: "📄", scissors: "✂️", well: "🪣" };

const ACTIONS = [
  { key: "rock", label: GLYPH.rock, hint: "Rock" },
  { key: "paper", label: GLYPH.paper, hint: "Paper" },
  { key: "scissors", label: GLYPH.scissors, hint: "Scissors" },
  { key: "well", label: GLYPH.well, hint: "Well" },
];

export const plugin = {
  idlTypes({ IDL }) {
    // Mirrors ../src/RockPaperScissorsWellRules.mo exactly — Candid
    // shape, not JS naming. A Motoko `Nat` field decodes to a JS `bigint`.
    const Action = IDL.Variant({
      rock: IDL.Null,
      paper: IDL.Null,
      scissors: IDL.Null,
      well: IDL.Null,
    });
    const Round = IDL.Record({
      p1Action: Action,
      p2Action: Action,
    });
    const State = IDL.Record({
      p1Score: IDL.Nat,
      p2Score: IDL.Nat,
      lastRound: IDL.Opt(Round),
    });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Full board markup for one game state, from mySeat's point of view.
  // Called for both a live game and a finished debrief's final state.
  renderBoard(gameState, mySeat, oppSeat) {
    const my = mySeat === "p1" ? gameState.p1Score : gameState.p2Score;
    const opp = oppSeat === "p1" ? gameState.p1Score : gameState.p2Score;

    const scoreboard = `
      <div class="rps-scoreboard">
        <span>You: ${my}</span>
        <span>Opponent: ${opp}</span>
      </div>`;

    const last = gameState.lastRound[0];
    if (!last) {
      return `${scoreboard}<p class="muted" style="text-align:center">No rounds played yet.</p>`;
    }
    const myAction = Object.keys(mySeat === "p1" ? last.p1Action : last.p2Action)[0];
    const oppAction = Object.keys(oppSeat === "p1" ? last.p1Action : last.p2Action)[0];
    const lastRoundHtml = `
      <div class="rps-last-round">
        <span title="${esc(myAction)}">${GLYPH[myAction]}</span>
        <span class="vs">vs</span>
        <span title="${esc(oppAction)}">${GLYPH[oppAction]}</span>
      </div>`;

    return `${scoreboard}${lastRoundHtml}`;
  },

  // Action buttons for mySeat — only ever called while it's legal for
  // them to move (the framework hides this once they've submitted).
  renderActions(gameState, mySeat) {
    return `<div class="rps-actions">${ACTIONS.map(
      (a) => `
        <button ${actionAttr({ [a.key]: null })} title="${esc(a.hint)}">
          <span class="act">${a.label}</span>
          <span class="rps-hint">${esc(a.hint)}</span>
        </button>`
    ).join("")}</div>`;
  },
};
