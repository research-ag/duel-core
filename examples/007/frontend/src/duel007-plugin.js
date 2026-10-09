// GamePlugin for the 007 duel. Candid shapes mirror ../Duel007Rules.mo;
// `legal()` is a cosmetic echo of that module's `validate`.

import { actionAttr, esc } from "duel-game-core/render.js";

const SHIELD_CAPACITY = 3n;
const START_MIRRORS = 3n;
const LASER_CHARGE = 5n;

const SEAT_NAME = { p1: "BOND", p2: "SILVA" };

const ACTIONS = [
  { key: "load", label: "LOAD", hint: "+1 ammo · 5 in a row charges the laser" },
  { key: "shoot", label: "SHOOT", hint: "spend 1 ammo" },
  { key: "shield", label: "SHIELD", hint: "absorbs a shot · breaks on the 3rd" },
  { key: "mirror", label: "MIRROR", hint: "reflects a shot back" },
];

function legal(me, action) {
  switch (action) {
    case "load":
      return true;
    case "shoot":
      return me.ammo > 0n || me.charge >= LASER_CHARGE;
    case "shield":
      return me.shieldHits < SHIELD_CAPACITY;
    case "mirror":
      return me.mirrors > 0n;
    default:
      return false;
  }
}

function pips(filled, total, cls) {
  let out = "";
  for (let i = 0n; i < total; i++) {
    out += `<i class="pip ${i < filled ? cls : "off"}"></i>`;
  }
  return out;
}

function statsPanel(who, seat, st, opts = {}) {
  const charged = st.charge >= LASER_CHARGE;
  const broken = st.shieldHits >= SHIELD_CAPACITY;
  const chargePips = st.charge > LASER_CHARGE ? LASER_CHARGE : st.charge;
  const shieldLeft = SHIELD_CAPACITY - (broken ? SHIELD_CAPACITY : st.shieldHits);
  return `
    <section class="agent ${opts.self ? "self" : ""}">
      <header>
        <span class="who">${esc(who)}</span>
        <span class="seat-label">${esc(SEAT_NAME[seat])}</span>
      </header>
      <dl>
        <div><dt>Ammo</dt><dd class="num">${st.ammo}</dd></div>
        <div>
          <dt>Laser</dt>
          <dd>
            ${pips(chargePips, LASER_CHARGE, "charge")}
            <span class="${charged ? "ready" : "muted"}">${
              charged ? "READY" : `${st.charge}/${LASER_CHARGE}`
            }</span>
          </dd>
        </div>
        <div>
          <dt>Shield</dt>
          <dd>
            ${pips(shieldLeft, SHIELD_CAPACITY, "shield")}
            <span class="${broken ? "broken" : "muted"}">${
              broken ? "BROKEN" : `${shieldLeft} left`
            }</span>
          </dd>
        </div>
        <div>
          <dt>Mirrors</dt>
          <dd>
            ${pips(st.mirrors, START_MIRRORS, "mirror")}
            <span class="muted">${st.mirrors} left</span>
          </dd>
        </div>
      </dl>
    </section>`;
}

function narration(gameState) {
  const r = gameState.lastRound[0];
  if (!r) return `<p class="narration muted">The duel begins.</p>`;
  return `<p class="narration">${esc(r.narration)}</p>`;
}

export const plugin = {
  idlTypes({ IDL }) {
    const AgentStats = IDL.Record({
      ammo: IDL.Nat,
      shieldHits: IDL.Nat,
      mirrors: IDL.Nat,
      charge: IDL.Nat,
    });
    const Action = IDL.Variant({
      load: IDL.Null,
      shoot: IDL.Null,
      shield: IDL.Null,
      mirror: IDL.Null,
    });
    const Round = IDL.Record({
      p1Action: Action,
      p2Action: Action,
      narration: IDL.Text,
    });
    // Nothing is hidden: the view is the whole state.
    const View = IDL.Record({
      p1: AgentStats,
      p2: AgentStats,
      lastRound: IDL.Opt(Round),
    });
    const Options = IDL.Record({});
    return { Action, View, Options };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Panels are always BOND left, SILVA right; only the label follows mySeat.
  renderBoard(gameState, mySeat, oppSeat) {
    const panel = (seat) =>
      statsPanel(seat === mySeat ? "You" : "Opponent", seat, gameState[seat], {
        self: seat === mySeat,
      });
    return `
      ${narration(gameState)}
      <div class="agents">
        ${panel("p1")}
        ${panel("p2")}
      </div>`;
  },

  // An order changes nothing visible until the round resolves; returning
  // the state as-is shows it committed the moment it is sent.
  applyLocal(gameState) {
    return gameState;
  },

  renderActions(gameState, mySeat) {
    const me = gameState[mySeat];
    return ACTIONS.map((a) => {
      const enabled = legal(me, a.key);
      return `
        <button ${actionAttr({ [a.key]: null })} ${enabled ? "" : "disabled"}>
          <span class="act">${a.label}</span>
          <span class="hint">${esc(a.hint)}</span>
        </button>`;
    }).join("");
  },
};
