// GamePlugin for rock-paper-scissors — the only game-specific piece the
// client needs. Everything else (the multi-table lobby, staging,
// rematch, debrief chrome, session identity, real-time push) comes from
// the duel-game-core npm package's generic start()/renderView() — see
// app.js. The Action/State Candid shapes here must mirror
// ../src/RockPaperScissorsRules.mo exactly. `legal()` below is a
// COSMETIC echo of that module's `validate` (disabled buttons only —
// every pick is always legal in well mode, and well alone is illegal in
// classic mode; the server is the only real legality gate regardless,
// CLAUDE.md architecture rule 4).
//
// Two table-time variants — Classic (rock/paper/scissors) and Well (a
// 4-symbol expansion, adding a well pick) — are picked once by a table's
// creator via `variantChoices()` below, never mid-match. `renderActions`
// shows the fourth WELL button only once the in-game state itself says
// `variant: well` (never from the picker's own last-clicked value, which
// has nothing to do with an ALREADY-staged/live game's actual rules).

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

// A Candid variant tag (`{classic: null}` / `{well: null}`) decodes to a
// JS object with exactly one key — same idiom render.js's own `tag()`
// helper uses.
function variantOf(gameState) {
  return Object.keys(gameState.variant)[0];
}

export const plugin = {
  idlTypes({ IDL }) {
    // Mirrors ../src/RockPaperScissorsRules.mo exactly — Candid shape,
    // not JS naming. A Motoko `Nat` field decodes to a JS `bigint`.
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

  // The two rules variants a table creator may pick between — the FIRST
  // entry (classic) is the default selection. See render.ts's
  // `renderBrowsing` for where this renders, and app.ts's
  // `readCreateVariant` for how the pick comes back on `createTable`.
  variantChoices() {
    return [
      { key: "classic", label: VARIANT_LABEL.classic },
      { key: "well", label: VARIANT_LABEL.well },
    ];
  },

  // Turns a stored `TableSummary.variant`/raw key into the same label
  // text `variantChoices` uses, so a browsing table row and the picker
  // that created it read identically. `""` (never actually stored by
  // this game, since createTable always sends a real key — but the
  // engine treats it as a safe default) falls back to Classic's own
  // label, matching `RockPaperScissorsRules.parseVariant`'s own default.
  formatVariant(variant) {
    return VARIANT_LABEL[variant] ?? VARIANT_LABEL.classic;
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
  // them to move (the framework hides this once they've submitted). The
  // well button renders only for a live well-mode match — reading
  // `gameState.variant`, the actual in-game state, never a picker choice
  // that may not even be visible any more (see this file's own header).
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
