// GamePlugin for chopsticks, plus what chopsticks-ui.js shares with it: the
// hand-card renderer and the cosmetic rules mirrors (`hit`, `splitValid`,
// `canSplit`, `splitReason`) of ../src/ChopsticksRules.mo. Candid shapes
// mirror that module too.

import { actionAttr, esc } from "duel-game-core/render.js";

export const SEAT_NAME = { p1: "Player 1", p2: "Player 2" };
export const HAND_NAME = { l: "Left", r: "Right" };
export const SIDES = ["l", "r"];
const MAX_HAND = 4;
const OUT_AT = 5;

export const RULE_SETS = [
  {
    key: "classic",
    title: "Classic Rules",
    emoji: "☝️",
    tagline: "Standard Chopsticks — easy to learn",
    rules: [
      "Any hand reaching 5 or more is eliminated",
      "Freely redistribute total fingers between your hands",
      "Pure swaps (e.g. 1+3 → 3+1) are not allowed",
    ],
    splitNote: "Split freely — any valid redistribution works",
    tone: "tap",
  },
  {
    key: "instructables",
    title: "Instructables Rules",
    emoji: "🖐️",
    tagline: "Harder wrap-around variant",
    rules: [
      "Only EXACTLY 5 kills a hand — going above wraps: 6→1, 7→2…",
      "Split only when one hand is dead AND the other is even",
      "Splits are always even — no free redistribution",
    ],
    splitNote: "Split only: one dead hand + even live hand → split evenly",
    tone: "secondary",
  },
];

export function ruleSetOf(variant) {
  return RULE_SETS.find((r) => r.key === variant) ?? RULE_SETS[0];
}

export const FINGER_ICONS = ["✊", "☝️", "✌️", "🤟", "🖖", "🖐️"];

export function variantOf(gameState) {
  return Object.keys(gameState.variant)[0];
}

export function handsOf(gameState, seat) {
  const h = gameState[seat];
  return { l: Number(h.l), r: Number(h.r) };
}

export function hit(variant, target, attacker) {
  const sum = target + attacker;
  if (variant === "instructables") return sum % OUT_AT;
  return sum >= OUT_AT ? 0 : sum;
}

// A reason the split is illegal, or null. Texts match `validateSplit`.
export function splitValid(variant, cur, l, r) {
  const total = cur.l + cur.r;
  if (total === 0) return "No fingers left to split.";
  if (l + r !== total) return "A split must keep the same total.";
  if (variant === "instructables") {
    if (cur.l > 0 && cur.r > 0) return "Split only when one hand is out.";
    if (total % 2 !== 0) return "Split only when the live hand is even.";
    if (l !== r) return "Splits are always even.";
    return null;
  }
  if (l > MAX_HAND || r > MAX_HAND) return "A hand can't hold five or more fingers.";
  if ((l === cur.l && r === cur.r) || (l === cur.r && r === cur.l)) {
    return "Must differ from current and not be a pure swap.";
  }
  return null;
}

export function legalSplits(variant, cur) {
  const total = cur.l + cur.r;
  const out = [];
  for (let l = 0; l <= total; l++) {
    if (splitValid(variant, cur, l, total - l) === null) out.push({ l, r: total - l });
  }
  return out;
}

export function canSplit(variant, cur) {
  return legalSplits(variant, cur).length > 0;
}

export function splitReason(variant, cur) {
  if (canSplit(variant, cur)) return null;
  if (cur.l === 0 && cur.r === 0) return "Both hands are eliminated.";
  if (variant === "instructables") {
    if (cur.l > 0 && cur.r > 0) return "Instructables: need one dead hand to split.";
    const live = cur.l > 0 ? cur.l : cur.r;
    if (live % 2 !== 0) return `Instructables: live hand (${live}) must be even to split.`;
    if (live < 2) return "Not enough fingers to split.";
  }
  return "No valid split available";
}

// ── Hand cards ──────────────────────────────────────────────────────────

function fingerDisplay(count, owner) {
  if (count === 0) {
    return `<div class="finger-display"><span class="finger-icon out">✊</span><span class="finger-out">Out</span></div>`;
  }
  return `<div class="finger-display">
    <span class="finger-icon" role="img" aria-label="${count} finger${count === 1 ? "" : "s"}">${FINGER_ICONS[count] ?? "🖐️"}</span>
    <span class="finger-count ${owner}">${count}</span>
  </div>`;
}

// `owner` is "you" or "opp"; `interactive` is `{ hand }` (select this hand
// of yours), `{ act }` (a submit-able attack on this opponent hand) or
// null; `anim` is "source", "target", "split" or null.
export function handCard({ owner, side, fingers, selected = false, lastMoved = false, targetable = false, interactive = null, anim = null }) {
  const out = fingers === 0;
  const live = interactive !== null && !out;
  const classes = ["hand-card", owner];
  if (anim === "source") classes.push("hc-ai-source");
  else if (anim === "target") classes.push("hc-ai-target");
  else if (selected) classes.push("hc-selected");
  else if (lastMoved) classes.push("hc-last-moved");
  else if (targetable && !out) classes.push("hc-targetable");
  if (anim === "split") classes.push("hc-ai-split");
  if (out) classes.push("hc-out");
  if (live) classes.push("hc-live");
  const attr = !live
    ? "disabled"
    : "hand" in interactive
      ? `data-hand="${interactive.hand}"`
      : actionAttr(interactive.act);
  const label = `${owner === "you" ? "your" : "opponent's"} ${HAND_NAME[side].toLowerCase()} hand: ${out ? "eliminated" : `${fingers} fingers`}`;
  return `<button type="button" class="${classes.join(" ")}" ${attr} aria-label="${esc(label)}">
    <span class="hand-label">${side.toUpperCase()}</span>
    ${fingerDisplay(fingers, owner)}
    ${selected ? `<span class="hand-badge selected">✓</span>` : ""}
    ${anim === "source" ? `<span class="hand-badge source">⚡</span>` : ""}
    ${anim === "target" ? `<span class="hand-badge target">💥</span>` : ""}
  </button>`;
}

// Both rows of hands from `mySeat`'s side of the table. `opts` (all
// optional): `oppLabel`/`youLabel`, `yourTurn`, `selected` (my attacking
// hand while picking a target), `lastMove` ({ mover, to } of the last
// attack) and `anim` ({ phase, move } replaying the opponent's last move).
export function renderHands(gameState, mySeat, oppSeat, opts = {}) {
  const mine = handsOf(gameState, mySeat);
  const theirs = handsOf(gameState, oppSeat);
  const { yourTurn = false, selected = null, lastMove = null, anim = null } = opts;
  const animRole = (owner, side) => {
    if (!anim) return null;
    const m = anim.move;
    if (m.kind === "split") return owner === "opp" ? "split" : null;
    if (owner === "opp" && m.from === side) return "source";
    if (owner === "you" && m.to === side && anim.phase === "target") return "target";
    return null;
  };
  const oppCard = (side) =>
    handCard({
      owner: "opp",
      side,
      fingers: theirs[side],
      lastMoved: !anim && lastMove !== null && lastMove.mover === mySeat && lastMove.to === side,
      targetable: yourTurn && selected !== null,
      interactive: yourTurn && selected !== null ? { act: { attack: { from: { [selected]: null }, to: { [side]: null } } } } : null,
      anim: animRole("opp", side),
    });
  const myCard = (side) =>
    handCard({
      owner: "you",
      side,
      fingers: mine[side],
      selected: selected === side,
      lastMoved: !anim && lastMove !== null && lastMove.mover === oppSeat && lastMove.to === side,
      targetable: yourTurn && selected === null,
      interactive: yourTurn ? { hand: side } : null,
      anim: animRole("you", side),
    });
  return `
    <div class="hands-group">
      <span class="hands-label">${esc(opts.oppLabel ?? SEAT_NAME[oppSeat])}</span>
      <div class="hands">${oppCard("l")}${oppCard("r")}</div>
    </div>
    <div class="vs-divider"><span></span><span class="vs">VS</span><span></span></div>
    <div class="hands-group">
      <div class="hands">${myCard("l")}${myCard("r")}</div>
      <span class="hands-label">${esc(opts.youLabel ?? "Player")}</span>
    </div>`;
}

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
    return RULE_SETS.map((r) => ({ key: r.key, label: r.title }));
  },

  formatVariant(variant) {
    return ruleSetOf(variant).title;
  },

  renderBoard(gameState, mySeat, oppSeat) {
    return `<div class="board">${renderHands(gameState, mySeat, oppSeat)}</div>`;
  },

  renderActions(gameState, mySeat) {
    const variant = variantOf(gameState);
    return legalSplits(variant, handsOf(gameState, mySeat))
      .map((s) => `<button ${actionAttr({ split: { l: s.l, r: s.r } })}>${s.l} · ${s.r}</button>`)
      .join("");
  },

  // Mirrors `resolve`, so your move is on the board while it is in flight.
  applyLocal(gameState, mySeat, move) {
    const nat = (h) => ({ l: BigInt(h.l), r: BigInt(h.r) });
    if ("split" in move) return { ...gameState, [mySeat]: nat(move.split) };
    const opp = mySeat === "p1" ? "p2" : "p1";
    const from = Object.keys(move.attack.from)[0];
    const to = Object.keys(move.attack.to)[0];
    const theirs = handsOf(gameState, opp);
    theirs[to] = hit(variantOf(gameState), theirs[to], handsOf(gameState, mySeat)[from]);
    return { ...gameState, [opp]: nat(theirs) };
  },
};
