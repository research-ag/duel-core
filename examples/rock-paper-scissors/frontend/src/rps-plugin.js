// GamePlugin for rock-paper-scissors. Candid shapes mirror
// ../src/RockPaperScissorsRules.mo. The WELL button renders only when the
// live game state says `variant: well`. The last round's two picks stay on
// screen through the debrief (`renderLastRound`).

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

/// Both picks of the most recent round, or "" before the first one. Also
/// drawn by app.js's debrief, so the deciding round stays on screen.
export function renderLastRound(gameState, mySeat, oppSeat) {
  const last = gameState.lastRound[0];
  if (!last) return "";
  const myAction = Object.keys(mySeat === "p1" ? last.p1Action : last.p2Action)[0];
  const oppAction = Object.keys(oppSeat === "p1" ? last.p1Action : last.p2Action)[0];
  return `
    <div class="rps-last-round">
      <span title="${esc(myAction)}">${GLYPH[myAction]}</span>
      <span class="vs">vs</span>
      <span title="${esc(oppAction)}">${GLYPH[oppAction]}</span>
    </div>`;
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
    // Nothing is hidden: the view is the whole state.
    const View = IDL.Record({
      p1Score: IDL.Nat,
      p2Score: IDL.Nat,
      lastRound: IDL.Opt(Round),
      variant: Variant,
      winsNeeded: IDL.Nat,
    });
    const Options = IDL.Record({ variant: Variant, winsNeeded: IDL.Nat });
    return { Action, View, Options };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // First to 3 round wins, in either symbol set.
  optionChoices() {
    return [
      { key: "classic", label: VARIANT_LABEL.classic, options: { variant: { classic: null }, winsNeeded: 3n } },
      { key: "well", label: VARIANT_LABEL.well, options: { variant: { well: null }, winsNeeded: 3n } },
    ];
  },

  formatOptions(options) {
    const label = VARIANT_LABEL[Object.keys(options.variant)[0]] ?? VARIANT_LABEL.classic;
    return `${label} · first to ${options.winsNeeded}`;
  },

  renderBoard(gameState, mySeat, oppSeat) {
    const my = mySeat === "p1" ? gameState.p1Score : gameState.p2Score;
    const opp = oppSeat === "p1" ? gameState.p1Score : gameState.p2Score;

    const scoreboard = `
      <div class="rps-scoreboard">
        <span>You: ${my}</span>
        <span>Opponent: ${opp}</span>
      </div>`;

    const lastRoundHtml = renderLastRound(gameState, mySeat, oppSeat);
    if (!lastRoundHtml) {
      return `${scoreboard}<p class="muted" style="text-align:center">No rounds played yet.</p>`;
    }
    return `${scoreboard}${lastRoundHtml}`;
  },

  // Nothing about a hidden pick changes the board; returning it as-is
  // still flips the screen to "locked in" the moment you click.
  applyLocal(gameState) {
    return gameState;
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
