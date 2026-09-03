// GamePlugin for the 007 duel — the only game-specific piece the client
// needs. Everything else (lobby, staging, rematch, debrief chrome, session
// identity, real-time push) comes from the `duel-game-core` npm package's
// generic `start()`/`renderView()` — see app.js.
//
// The `Action`/`State` Candid shapes and the LOAD/SHOOT/SHIELD/MIRROR rules
// they describe must mirror `../Duel007Rules.mo` exactly; `legal()` below
// is a cosmetic echo of that module's `validate` (CLAUDE.md architecture
// rule 4 — the server is the only real legality gate).

import { actionAttr, esc } from "./node_modules/duel-game-core/dist/render.js";

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
  // `charge` keeps counting past 5, so clamp the pip row.
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
    const State = IDL.Record({
      p1: AgentStats,
      p2: AgentStats,
      lastRound: IDL.Opt(Round),
    });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Called both for a live game and for a finished debrief's final state.
  // render.js already wraps this in a `.board` div — the two-panel grid
  // gets its own `.agents` class so the narration paragraph above it
  // doesn't become a stray third grid cell.
  renderBoard(gameState, mySeat, oppSeat) {
    return `
      ${narration(gameState)}
      <div class="agents">
        ${statsPanel("You", mySeat, gameState[mySeat], { self: true })}
        ${statsPanel("Opponent", oppSeat, gameState[oppSeat])}
      </div>`;
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
