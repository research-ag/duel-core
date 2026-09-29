// GamePlugin for rock-paper-scissors. Candid shapes mirror
// ../src/RockPaperScissorsRules.mo. The WELL button renders only when the
// live game state says `variant: well`.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "Player 1", p2: "Player 2" };
const GLYPH = { rock: "🪨", paper: "📄", scissors: "✂️", well: "🪣" };

const ACTIONS = [
  { key: "rock", label: GLYPH.rock, hint: "Rock" },
  { key: "paper", label: GLYPH.paper, hint: "Paper" },
  { key: "scissors", label: GLYPH.scissors, hint: "Scissors" },
];
const WELL_ACTION = { key: "well", label: GLYPH.well, hint: "Well" };

const VARIANT_LABEL = { classic: "Classic — 🪨📄✂️", well: "Well — 🪨📄✂️🪣" };

function variantOf(gameState) {
  return Object.keys(gameState.variant)[0];
}

export const plugin = {
  idlTypes({ IDL }) {
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
    const Variant = IDL.Variant({ classic: IDL.Null, well: IDL.Null });
    const State = IDL.Record({
      p1Score: IDL.Nat,
      p2Score: IDL.Nat,
      lastRound: IDL.Opt(Round),
      variant: Variant,
    });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  variantChoices() {
    return [
      { key: "classic", label: VARIANT_LABEL.classic },
      { key: "well", label: VARIANT_LABEL.well },
    ];
  },

  formatVariant(variant) {
    return VARIANT_LABEL[variant] ?? VARIANT_LABEL.classic;
  },

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

  renderActions(gameState, mySeat) {
    const actions = variantOf(gameState) === "well" ? [...ACTIONS, WELL_ACTION] : ACTIONS;
    return `<div class="rps-actions">${actions.map(
      (a) => `
        <button ${actionAttr({ [a.key]: null })} title="${esc(a.hint)}">
          <span class="act">${a.label}</span>
          <span class="rps-hint">${esc(a.hint)}</span>
        </button>`
    ).join("")}</div>`;
  },
};
