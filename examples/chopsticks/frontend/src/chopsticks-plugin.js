// GamePlugin for chopsticks — the only game-specific piece the client
// needs; the lobby/staging/rematch/debrief chrome, session identity, and
// real-time push all come from duel-game-core's generic start()/
// renderView() (see app.js). The Candid shapes below must mirror
// ../src/ChopsticksRules.mo exactly, and the split legality mirrored here
// is cosmetic only — the server's `validate` is the real gate.
//
// Interaction: tap one of your own live hands to select it, then tap an
// opponent's live hand to attack it (a real `<button data-act=...>`,
// submitted by app.js's own click handling). Splits are buttons under
// the board — every legal one in Classic, the single even split in
// Instructables. Selection state lives in this module alone and resets
// whenever a new position arrives or it isn't this seat's turn.

import { actionAttr, esc } from "duel-game-core/render.js";

const SEAT_NAME = { p1: "Player 1", p2: "Player 2" };
const HAND_NAME = { l: "Left", r: "Right" };
const MAX_HAND = 4;

const VARIANT_LABEL = {
  classic: "Classic — 5 or more is out, split freely",
  instructables:
    "Instructables — exactly 5 is out, wraps past it, even splits only",
};

let selected = null;
let lastKey = null;
let cached = null;

function variantOf(gameState) {
  return Object.keys(gameState.variant)[0];
}

function handsOf(gameState, seat) {
  const h = gameState[seat];
  return { l: Number(h.l), r: Number(h.r) };
}

function fingers(n) {
  return n === 0 ? "✊" : "│".repeat(n);
}

function splitsFor(variant, cur) {
  const total = cur.l + cur.r;
  if (total === 0) return [];
  if (variant === "instructables") {
    const oneOut = cur.l === 0 || cur.r === 0;
    return oneOut && total % 2 === 0 ? [{ l: total / 2, r: total / 2 }] : [];
  }
  const out = [];
  for (let l = 0; l <= total; l++) {
    const r = total - l;
    if (l > MAX_HAND || r > MAX_HAND) continue;
    if ((l === cur.l && r === cur.r) || (l === cur.r && r === cur.l)) continue;
    out.push({ l, r });
  }
  return out;
}

function handCard(seat, id, count, { mine, interactive }) {
  const classes = ["cs-hand", `cs-${seat}`, mine ? "cs-mine" : "cs-theirs"];
  if (count === 0) classes.push("cs-out");
  const body = `<span class="cs-fingers">${fingers(count)}</span><span class="cs-count">${count === 0 ? "OUT" : count}</span><span class="cs-label">${HAND_NAME[id]}</span>`;
  const title = `${HAND_NAME[id]} hand: ${count === 0 ? "out" : `${count} finger${count === 1 ? "" : "s"}`}`;
  if (!interactive || count === 0) {
    return `<div class="${classes.join(" ")}" title="${esc(title)}">${body}</div>`;
  }
  if (mine) {
    if (selected === id) classes.push("cs-selected");
    return `<button type="button" class="${classes.join(" ")}" data-hand="${id}" title="${esc(title)}">${body}</button>`;
  }
  const act = { attack: { from: { [selected]: null }, to: { [id]: null } } };
  classes.push("cs-target");
  return `<button type="button" class="${classes.join(" ")}" ${actionAttr(act)} title="${esc(`Attack the ${HAND_NAME[id].toLowerCase()} hand`)}">${body}</button>`;
}

function drawBoard(gameState, mySeat, oppSeat, yourTurn) {
  const mine = handsOf(gameState, mySeat);
  const theirs = handsOf(gameState, oppSeat);
  const row = (seat, hands, opts) =>
    `<div class="cs-row">${handCard(seat, "l", hands.l, opts)}${handCard(seat, "r", hands.r, opts)}</div>`;
  const hint = !yourTurn
    ? ""
    : selected
      ? `<p class="cs-hint">Now tap an opponent's hand to attack.</p>`
      : `<p class="cs-hint">Tap one of your hands to attack, or split below.</p>`;
  return `<div class="cs-board">
    ${row(oppSeat, theirs, { mine: false, interactive: yourTurn && selected !== null })}
    <div class="cs-vs">vs</div>
    ${row(mySeat, mine, { mine: true, interactive: yourTurn })}
    ${hint}
  </div>`;
}

function rerender() {
  const boardEl = document.querySelector(".cs-board");
  if (!boardEl || !cached) return;
  boardEl.outerHTML = drawBoard(
    cached.gameState,
    cached.mySeat,
    cached.oppSeat,
    true
  );
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-hand], [data-act]");
  if (!el || !el.closest(".cs-board")) return;
  if (el.dataset.act !== undefined) {
    selected = null;
    return;
  }
  selected = selected === el.dataset.hand ? null : el.dataset.hand;
  rerender();
});

export const plugin = {
  idlTypes({ IDL }) {
    const HandId = IDL.Variant({ l: IDL.Null, r: IDL.Null });
    const Hands = IDL.Record({ l: IDL.Nat, r: IDL.Nat });
    const Variant = IDL.Variant({ classic: IDL.Null, instructables: IDL.Null });
    const Action = IDL.Variant({
      attack: IDL.Record({ from: HandId, to: HandId }),
      split: IDL.Record({ l: IDL.Nat, r: IDL.Nat }),
    });
    const State = IDL.Record({ variant: Variant, p1: Hands, p2: Hands });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  variantChoices() {
    return [
      { key: "classic", label: VARIANT_LABEL.classic },
      { key: "instructables", label: VARIANT_LABEL.instructables },
    ];
  },

  formatVariant(variant) {
    return VARIANT_LABEL[variant] ?? VARIANT_LABEL.classic;
  },

  renderBoard(gameState, mySeat, oppSeat, yourTurn) {
    const key = JSON.stringify([gameState.p1, gameState.p2], (_k, v) =>
      typeof v === "bigint" ? Number(v) : v
    );
    if (key !== lastKey) {
      lastKey = key;
      selected = null;
    }
    if (!yourTurn) selected = null;
    cached = { gameState, mySeat, oppSeat };
    return drawBoard(gameState, mySeat, oppSeat, !!yourTurn);
  },

  renderActions(gameState, mySeat) {
    const variant = variantOf(gameState);
    const splits = splitsFor(variant, handsOf(gameState, mySeat));
    if (splits.length === 0) {
      return variant === "instructables"
        ? `<p class="muted cs-split-hint">Split only when one hand is out and the other is even.</p>`
        : "";
    }
    const buttons = splits
      .map(
        (s) =>
          `<button ${actionAttr({ split: { l: s.l, r: s.r } })} title="${esc(`Split into ${s.l} and ${s.r}`)}">${s.l} · ${s.r}</button>`
      )
      .join("");
    return `<div class="cs-splits"><span class="cs-split-label">${variant === "instructables" ? "Split evenly" : "Split"}</span>${buttons}</div>`;
  },
};
