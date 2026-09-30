// Chopsticks' own UI over duel-game-core's headless client: the dark
// arcade look (hand cards, split slider, opponent-move replay, move
// history, tutorial, leaderboard, opponent and rules pickers). Every
// screen is a function of `ClientState` plus this module's local state;
// every control calls one client method. Nothing here comes from
// `duel-game-core/render.js` but pure text helpers; the hand cards are
// chopsticks-plugin.js's. See ../../../../frontend/README.md, "The
// headless client".

import { atTableOf, claimRoleOf, errText, localSecondsElapsed, localSecondsLeft, oppSeatOf, tag, viewOf } from "duel-game-core/client.js";
import { esc, isCanisterPlayer, parseCanisterPlayer, playerKeyOf, truncatePlayerId } from "duel-game-core/render.js";
import { HAND_NAME, RULE_SETS, SEAT_NAME, SIDES, canSplit, handsOf, hit, renderHands, ruleSetOf, splitReason, splitValid, variantOf } from "./chopsticks-plugin.js";

const IDLE_WARNING_SECS = 30n;
const CLAIM_WARNING_SECS = 15n;
const RECLAIM_WARNING_SECS = 15n;
const ANIM_SOURCE_MS = 900;
const ANIM_TARGET_MS = 700;
const HISTORY_SHOWN = 10;
const TUTORIAL_KEY = "chopsticks-tutorial-seen";
const RECORD_KEY = "chopsticks-record";
const LAST_BOT_KEY = "duel-last-bot";

const CHARACTERS = {
  Bunny: { emoji: "🐰", difficulty: "easy" },
  Fox: { emoji: "🦊", difficulty: "medium" },
  Bear: { emoji: "🐻", difficulty: "hard" },
};

const DIFFICULTY = {
  easy: { label: "Easy", flavor: "Just learning to play! Perfect for first-timers.", tone: "tap", stars: 1 },
  medium: { label: "Medium", flavor: "Knows the rules and plays smart. A fair challenge.", tone: "primary", stars: 2 },
  hard: { label: "Hard", flavor: "Plays to win. Not going easy on you!", tone: "secondary", stars: 3 },
};

const TUTORIAL_STEPS = [
  { icon: "☝️", title: "Start with 1 finger", desc: "Each player begins with one finger raised on each hand." },
  {
    icon: "👆",
    title: "Tap to attack",
    desc: "On your turn, tap one of your hands against an opponent's hand. Your finger count is added to theirs.",
  },
  {
    icon: "💀",
    title: "Eliminate a hand",
    desc: "Classic: reaching 5+ knocks a hand out. Instructables: only exactly 5 kills — going above wraps around (6→1, 7→2…).",
  },
  {
    icon: "↔️",
    title: "Split your fingers",
    desc: "Classic: freely redistribute total fingers between your hands. Instructables: only split when one hand is dead AND the other is even — result is always even halves.",
  },
  { icon: "🏆", title: "Eliminate both hands to win", desc: "The first player to knock out BOTH of the opponent's hands wins the game!" },
];

const FEATURES = [
  { label: "Track Wins", emoji: "🏆" },
  { label: "Leaderboard", emoji: "📊" },
  { label: "Two Rule Sets", emoji: "🎮" },
];

// A bot's way of playing as the game presents it.
function characterOf(complexity) {
  const c = CHARACTERS[complexity];
  return c ? { emoji: c.emoji, name: complexity, difficulty: c.difficulty } : { emoji: "🤖", name: complexity, difficulty: "medium" };
}

function stagingOf(status) {
  const at = atTableOf(status);
  const v = viewOf(status, "stagingYou");
  if (!at || !v) return null;
  return {
    tableId: at.id,
    openSeat: tag(v.seat) === "p1" ? { p2: null } : { p1: null },
    code: "code" in v.visibility ? [v.visibility.code] : [],
  };
}

function storageGet(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (_) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

// ── Pieces ───────────────────────────────────────────────────────────────

function pill(tone, inner, extra = "") {
  return `<span class="pill ${tone} ${extra}">${inner}</span>`;
}

function recordStrip(record) {
  return `<div class="record-strip">
    <span><i class="dot tap"></i><b class="tap">W</b><b>${record.wins}</b></span>
    <span class="sep">│</span>
    <span><i class="dot secondary"></i><b class="secondary">L</b><b>${record.losses}</b></span>
    <span class="sep">│</span>
    <span><i class="dot muted"></i><b class="muted">D</b><b>${record.draws}</b></span>
  </div>`;
}

function ruleSetBadge(variant) {
  const rs = ruleSetOf(variant);
  return pill(rs.tone, `<span role="img">${rs.emoji}</span> ${esc(rs.title)}`);
}

function opponentBadge(opp) {
  const tone = opp.bot ? DIFFICULTY[opp.difficulty].tone : "primary";
  return pill(tone, `<span role="img">${opp.emoji}</span> vs ${esc(opp.name)}`);
}

function statusBadge({ myTurn, animating, selecting, opp }) {
  let text;
  let dot;
  if (animating) {
    text = `${opp.name} is moving…`;
    dot = "secondary pulse";
  } else if (!myTurn) {
    text = opp.bot ? `${opp.name} is thinking…` : `${opp.name}'s turn`;
    dot = "secondary";
  } else if (selecting) {
    text = "Tap an opponent's hand";
    dot = "secondary pulse";
  } else {
    text = "Your turn — tap a hand or split";
    dot = "tap pulse";
  }
  return `<div class="status-badge"><i class="dot ${dot}"></i><span>${esc(text)}</span></div>`;
}

function moveBanner(opp, anim) {
  let icon;
  let text;
  let cls = "";
  if (!anim) {
    icon = opp.bot ? "🤔" : "⏳";
    text = opp.bot ? `${opp.name} is thinking…` : `Waiting for ${opp.name}…`;
  } else if (anim.phase === "source") {
    icon = anim.move.kind === "attack" ? "⚡" : "↔️";
    text = anim.move.kind === "attack" ? `${opp.name}'s ${HAND_NAME[anim.move.from]} hand is attacking…` : `${opp.name} is splitting fingers…`;
    cls = "source";
  } else {
    icon = anim.move.kind === "attack" ? "💥" : "✅";
    text = anim.move.kind === "attack" ? `Hitting your ${HAND_NAME[anim.move.to]} hand!` : "Fingers redistributed!";
    cls = "target";
  }
  return `<div class="move-banner ${cls}"><span class="icon" role="img">${icon}</span><span>${esc(text)}</span></div>`;
}

function modal(inner, { z = "z40", cls = "", closeOp = null } = {}) {
  return `<div class="overlay-layer ${z}">
    ${closeOp ? `<button type="button" class="backdrop" data-op="${closeOp}" aria-label="Close"></button>` : `<div class="backdrop"></div>`}
    <div class="modal-card ${cls}">${inner}</div>
  </div>`;
}

// ── Move history ────────────────────────────────────────────────────────

const CELL_SIZE = 26;
const CELL_GAP = 6;
const LABEL_COL_W = 20;
const COL_HEADER_H = 14;
const SVG_W = LABEL_COL_W + 2 * CELL_SIZE + CELL_GAP + 4;
const SVG_H = COL_HEADER_H + 2 * CELL_SIZE + CELL_GAP + 4;
const CELL_POSITIONS = {
  oppLeft: { row: 0, col: 0 },
  oppRight: { row: 0, col: 1 },
  youLeft: { row: 1, col: 0 },
  youRight: { row: 1, col: 1 },
};

function cellCenter({ row, col }) {
  return {
    x: LABEL_COL_W + col * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2,
    y: COL_HEADER_H + row * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2,
  };
}

function attackArrow(fromKey, toKey, isYou) {
  const fc = cellCenter(CELL_POSITIONS[fromKey]);
  const tc = cellCenter(CELL_POSITIONS[toKey]);
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const len = Math.hypot(dx, dy);
  const shrink = 10;
  const ux = dx / len;
  const uy = dy / len;
  const color = isYou ? "oklch(0.58 0.19 262)" : "oklch(0.65 0.28 318)";
  const id = `arrowhead-${isYou ? "p" : "a"}`;
  return `<svg width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" class="history-arrow" aria-hidden="true">
    <defs><marker id="${id}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>
    <line x1="${fc.x + ux * shrink}" y1="${fc.y + uy * shrink}" x2="${tc.x - ux * shrink}" y2="${tc.y - uy * shrink}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" marker-end="url(#${id})"/>
  </svg>`;
}

function boardGrid(entry, oppShort) {
  const { before, after } = entry;
  const isYou = entry.you;
  const isAttack = entry.kind === "attack";
  const attackerKey = isAttack ? (isYou ? "you" : "opp") + HAND_NAME[entry.from] : null;
  const targetKey = isAttack ? (isYou ? "opp" : "you") + HAND_NAME[entry.to] : null;
  const changed = Object.keys(CELL_POSITIONS).filter((k) => before[k] !== after[k]);
  const cell = (key) => {
    const value = before[key];
    const dead = value === 0;
    const isAttacker = key === attackerKey;
    const isTarget = key === targetKey;
    const overlay = (isTarget || (!isAttack && changed.includes(key))) && after[key] !== undefined;
    const cls = isAttacker ? "attacker" : isTarget ? "target" : dead ? "dead" : "";
    const badge = overlay ? `<span class="cell-badge ${after[key] === 0 ? "dead" : ""}">${after[key] === 0 ? "✕" : after[key]}</span>` : "";
    return `<span class="history-cell" style="width:${CELL_SIZE}px;height:${CELL_SIZE}px"><span class="history-cell-inner ${cls}">${dead ? "✕" : value}</span>${badge}</span>`;
  };
  const row = (label, rowIdx, keys) =>
    `<div class="history-row" style="top:${COL_HEADER_H + rowIdx * (CELL_SIZE + CELL_GAP)}px;gap:${CELL_GAP}px">
      <span class="history-row-label" style="width:${LABEL_COL_W - CELL_GAP}px">${esc(label)}</span>${keys.map(cell).join("")}
    </div>`;
  return `<div class="history-grid" style="width:${SVG_W}px;height:${SVG_H}px">
    ${isAttack ? attackArrow(attackerKey, targetKey, isYou) : ""}
    <span class="history-col-label" style="left:${LABEL_COL_W}px;width:${CELL_SIZE}px">L</span>
    <span class="history-col-label" style="left:${LABEL_COL_W + CELL_SIZE + CELL_GAP}px;width:${CELL_SIZE}px">R</span>
    ${row(oppShort, 0, ["oppLeft", "oppRight"])}
    ${row("You", 1, ["youLeft", "youRight"])}
  </div>`;
}

function moveItem(entry, oppShort) {
  const mover = entry.you ? "You" : oppShort;
  const label =
    entry.kind === "attack"
      ? `${mover}'s ${entry.from.toUpperCase()} → ${entry.you ? oppShort : "You"}'s ${entry.to.toUpperCase()}`
      : `${mover} split`;
  return `<div class="history-item ${entry.you ? "you" : "opp"}">
    <div class="history-head">
      <span class="mover">${esc(mover)}</span>
      <span class="turn">T${entry.ply + 1n}</span>
      <span class="kind">${entry.kind === "attack" ? "⚡ attack" : "↔ split"}</span>
    </div>
    <p class="history-label">${esc(label)}</p>
    <div class="history-grid-wrap">${boardGrid(entry, oppShort)}</div>
  </div>`;
}

function moveHistory(moves, oppShort) {
  const shown = [...moves].reverse().slice(0, HISTORY_SHOWN);
  return `<div class="move-history">
    <h3>Move History</h3>
    ${
      shown.length === 0
        ? `<div class="history-empty"><p>No moves yet.<br />Start playing!</p></div>`
        : `<div class="history-list">${shown.map((m) => moveItem(m, oppShort)).join("")}</div>`
    }
  </div>`;
}

// ── Mounting ─────────────────────────────────────────────────────────────

export function mountChopsticksUi({ client, plugin, services, els }) {
  const { screen, overlay, alert, sid, switchBtn, authBtn, leaderboardBtn, tutorialBtn, confirmDialog, codeDialog } = els;
  const session = client.session;

  // Local UI state. `anim` replays the opponent's last move on the board
  // it was played on before the new position is shown.
  let mode = "idle"; // "idle" | "select-target"
  let selected = null;
  let anim = null;
  let animTimer = null;
  let split = null; // { left } while the split dialog is open
  let start = null; // { step: "ai-picker" | "rule-select", purpose: "bot" | "friend" | "add-bot", bot? }
  let bots = null; // BotInfo[] | { error } | null while loading
  let tutorial = null; // { step } while open
  let leaderboard = null; // { entries, botNames } | { error } | { loading } while open
  let pendingBotInvite = null; // { bot, stage: "creating" | "inviting" }
  let reinvited = null;
  // The last string written to `overlay.innerHTML`, so an unrelated push
  // (an opponent's move, a clock tick) doesn't tear down and recreate an
  // already-open modal — which would replay its CSS open animation.
  let lastOverlayHtml = null;
  let history = { key: null, game: null, turn: null, moves: [] };
  let lastBot = storageGet(LAST_BOT_KEY);
  if (lastBot) lastBot = { ...lastBot, tableId: BigInt(lastBot.tableId) };
  // Per identity, in this browser. `last` is the ending counted most
  // recently, so a reload onto the same debrief does not count it twice.
  const recordKey = `${RECORD_KEY}:${client.sid}`;
  let record = { wins: 0, losses: 0, draws: 0, last: null, ...storageGet(recordKey) };

  function setLastBot(bot) {
    lastBot = bot;
    storageSet(LAST_BOT_KEY, bot ? { ...bot, tableId: bot.tableId.toString() } : null);
  }

  function opponentOf(tableId, oppSeat) {
    if (lastBot && lastBot.tableId === tableId) return { ...characterOf(lastBot.complexity), bot: true };
    return { emoji: "👤", name: SEAT_NAME[oppSeat], bot: false };
  }

  // ── Screens ────────────────────────────────────────────────────────────

  function tableRow(r) {
    const rs = ruleSetOf(r.variant);
    const seatCell = (seat, open, occupant) => {
      if (open) {
        return `<button type="button" class="btn-small primary" data-op="join" data-table="${r.id}" data-seat="${seat}" data-key="jointable:${r.id}:${seat}"${r.protected ? " data-protected" : ""}>Join as ${esc(SEAT_NAME[seat])}</button>`;
      }
      const who = occupant.length === 1 ? occupant[0] : "";
      const bot = who !== "" && isCanisterPlayer(who);
      return `<span class="taken" title="${esc(who)}">${esc(SEAT_NAME[seat])} · ${bot ? "🤖 bot" : who ? esc(truncatePlayerId(who).text) : "taken"}</span>`;
    };
    return `<div class="table-row">
      <span class="table-id">#${r.id}</span>
      ${pill(rs.tone, `${rs.emoji} ${esc(rs.title)}`)}
      ${r.protected ? pill("muted", "🔒 Code") : ""}
      <span class="clock" data-clock="wait" data-base="${r.waitingSecs}">waiting ${r.waitingSecs}s</span>
      <span class="table-seats">${seatCell("p1", r.p1Open, r.p1Session)}${seatCell("p2", r.p2Open, r.p2Session)}</span>
    </div>`;
  }

  function browsingScreen(v) {
    return `<div class="hero">
      <span class="hero-hand" role="img" aria-label="hands">✋</span>
      <h2>Welcome to Chopsticks</h2>
      <p>Take on a bot, or open a second tab and play a friend. Your Player ID is per browser tab unless you log in.</p>
      <div class="hero-actions">
        <button type="button" class="btn-action primary" data-op="play-ai">Play vs AI →</button>
        <button type="button" class="btn-action muted" data-op="play-friend">Play vs a Friend</button>
      </div>
      <div class="features">${FEATURES.map((f) => `<span><span class="emoji" role="img" aria-label="${esc(f.label)}">${f.emoji}</span><span>${esc(f.label)}</span></span>`).join("")}</div>
    </div>
    <section class="tables">
      <h3>Open Tables</h3>
      ${v.tables.length === 0 ? `<p class="faint">No open tables. Start one above.</p>` : v.tables.map(tableRow).join("")}
    </section>`;
  }

  function lobbyScreen(id, v) {
    const seatBtn = (seat, open) =>
      `<button type="button" class="seat-card" data-op="join" data-table="${id}" data-seat="${seat}" data-key="jointable:${id}:${seat}" ${open ? "" : "disabled"}>
        <span class="seat-name">${esc(SEAT_NAME[seat])}</span><span class="faint">${open ? "seat open" : "taken"}</span>
      </button>`;
    return `<div class="panel center">
      <span class="text-4xl" role="img">✋</span>
      <h2>Table #${id}</h2>
      <p class="faint mono">Choose your seat</p>
      <div class="seat-cards">${seatBtn("p1", v.p1Open)}${seatBtn("p2", v.p2Open)}</div>
      ${v.resetAvailable ? `<button type="button" class="btn-text" data-op="reset" data-key="reset">Clear the abandoned board</button>` : ""}
    </div>`;
  }

  function busyScreen(id, v) {
    return `<div class="panel center">
      <span class="text-4xl" role="img">🚧</span>
      <h2>Table #${id} is in use</h2>
      <p class="faint">Another game is under way.</p>
      <p class="clock warn" data-clock="busy" data-base="${v.secondsUntilTakeover}">${v.secondsUntilTakeover}s until it can be taken over</p>
    </div>`;
  }

  function stagingScreen(id, v, variant) {
    const seat = tag(v.seat);
    const code = "code" in v.visibility ? v.visibility.code : null;
    const rs = ruleSetOf(variant);
    const inviting = pendingBotInvite !== null;
    const brief = v.reservedForPartner
      ? "The other seat is held for your last opponent for a moment — after that anyone may take it."
      : code !== null
        ? "Protected table. Share the table number and the code with a friend."
        : "Open table. A second tab, or anyone in the lobby, can take the other seat.";
    return `<div class="panel center">
      <span class="text-4xl wave" role="img">✋</span>
      <h2>${inviting ? `Inviting ${esc(pendingBotInvite.bot.complexity)}…` : "Waiting for an opponent…"}</h2>
      <p class="faint mono">Table #${id} · ${esc(rs.title)} · You are ${esc(SEAT_NAME[seat])}</p>
      <p class="faint">${brief}</p>
      ${code !== null ? `<p class="code-line"><span class="lbl">Code</span><code class="code">${esc(code)}</code></p>` : ""}
      <p class="clock warn" data-clock="reclaim" data-base="${v.secondsUntilReclaimable}" ${v.secondsUntilReclaimable > RECLAIM_WARNING_SECS ? "hidden" : ""}></p>
      <div class="row">
        ${inviting ? "" : `<button type="button" class="btn-action accent" data-op="add-bot">🤖 Add a Bot</button>`}
        <button type="button" class="btn-action muted" data-op="leave" data-key="leave">Cancel</button>
      </div>
    </div>`;
  }

  function rematchScreen(v) {
    return `<div class="panel center">
      <span class="text-4xl" role="img">🔁</span>
      <h2>Rematch?</h2>
      <p class="faint">Your last opponent wants another game and is holding <b>${esc(SEAT_NAME[tag(v.openSeat)])}</b> for you.</p>
      <div class="row">
        <button type="button" class="btn-action tap" data-op="rematch" data-key="rematch">Accept</button>
        <button type="button" class="btn-action muted" data-op="leave" data-key="leave">Decline</button>
      </div>
    </div>`;
  }

  function actionBar({ myTurn, animating, variant, mine, opp, pending }) {
    const blocked = animating || pending;
    const splitOk = canSplit(variant, mine);
    const reason = splitReason(variant, mine);
    const splitImpossible = myTurn && !blocked && !splitOk;
    const hint = animating
      ? `Watch ${opp.name}'s move…`
      : pending
        ? "Sending your move…"
        : mode === "select-target"
          ? "Now tap an opponent's hand to attack."
          : myTurn
            ? "Tap one of your hands to attack, or press Split."
            : `Waiting for ${opp.name}…`;
    const disabled = !splitOk || !myTurn || blocked;
    return `<div class="action-bar">
      ${
        mode === "select-target" && myTurn && !blocked
          ? `<button type="button" class="btn-action muted full" data-op="cancel-target">✕ Cancel</button>`
          : `<div class="split-wrap">
            <button type="button" class="btn-action tap full" data-op="split-open" ${disabled ? "disabled" : ""} ${splitImpossible ? `title="${esc(reason)}"` : ""}>
              <span>↔</span> ${variant === "instructables" ? "Split Evenly" : "Split"}
            </button>
            ${splitImpossible ? `<p class="split-reason">${esc(reason)}</p>` : ""}
          </div>`
      }
      <p class="hint">${esc(hint)}</p>
    </div>`;
  }

  function warnings(v) {
    const role = claimRoleOf(v);
    return `
      ${v.youSubmitted ? "" : `<p class="clock warn" data-clock="idle" data-base="${v.secondsUntilIdleReset}" hidden></p>`}
      ${
        role === null
          ? ""
          : `<p class="clock warn" data-clock="claim" data-role="${role}" data-base="${v.secondsUntilClaimable}" hidden></p>
             ${role === "waiting" ? `<button type="button" class="btn-action tap" data-op="claim" data-key="claim-win" data-clock="claim-button" data-base="${v.secondsUntilClaimable}" ${v.claimWinAvailable ? "" : "hidden"}>Claim the win</button>` : ""}`
      }`;
  }

  function boardScreen(id, game, me, live, pending) {
    const opp = oppSeatOf(me);
    const who = opponentOf(id, opp);
    const shownGame = anim ? anim.game : game;
    const variant = variantOf(shownGame);
    const myTurn = live !== null && !live.youSubmitted && !anim;
    const last = history.moves.length > 0 ? history.moves[history.moves.length - 1] : null;
    const lastMove = last && last.kind === "attack" ? { mover: last.you ? me : opp, to: last.to } : null;
    const oppShort = who.bot ? "AI" : "Opp";
    return `<div class="game-main">
      <div class="board-col">
        <div class="badges-row">${recordStrip(record)}${ruleSetBadge(variant)}${opponentBadge(who)}</div>
        <div class="status-row">${live === null ? "" : statusBadge({ myTurn: myTurn && !pending, animating: anim !== null, selecting: mode === "select-target", opp: who })}</div>
        ${live !== null && (anim !== null || !myTurn) ? moveBanner(who, anim) : ""}
        <div class="board">${renderHands(shownGame, me, opp, {
          oppLabel: `${who.emoji} ${who.name}${who.bot ? " (AI)" : ""}`,
          youLabel: `You · ${SEAT_NAME[me]}`,
          yourTurn: myTurn && !pending,
          selected: mode === "select-target" ? selected : null,
          lastMove,
          anim,
        })}</div>
        ${live === null ? "" : actionBar({ myTurn, animating: anim !== null, variant, mine: handsOf(shownGame, me), opp: who, pending })}
        ${live === null ? "" : warnings(live)}
        ${live === null ? "" : `<button type="button" class="btn-text" data-op="forfeit">✕ Forfeit</button>`}
      </div>
      <aside class="history-aside">${moveHistory(history.moves, oppShort)}</aside>
    </div>`;
  }

  function endedByOtherScreen() {
    return `<div class="panel center">
      <span class="text-4xl" role="img">💤</span>
      <h2>Your game was ended</h2>
      <p class="faint">The board sat idle too long and was reclaimed. Your game is gone.</p>
      <button type="button" class="btn-action primary" data-op="ack" data-key="ack">Back to lobby</button>
    </div>`;
  }

  function renderScreen(state) {
    const { status } = state;
    if (status === null) return `<div class="panel center"><h2 class="faint">Loading game…</h2></div>`;
    if ("browsing" in status) return browsingScreen(status.browsing);
    const { id, view } = status.atTable;
    const t = tag(view);
    const v = view[t];
    const pending = state.pending !== null;
    switch (t) {
      case "lobby":
        return lobbyScreen(id, v);
      case "busy":
        return busyScreen(id, v);
      case "stagingYou":
        return stagingScreen(id, v, tableVariantOf(state, id));
      case "awaitingRematch":
        return rematchScreen(v);
      case "inGame":
        return boardScreen(id, v.game, tag(v.seat), v, pending);
      case "debrief":
        return boardScreen(id, v.finalGame, tag(v.seat), null, pending);
      case "endedByOther":
        return endedByOtherScreen();
      default:
        return `<p class="alert-text">Unknown view: ${esc(t)}</p>`;
    }
  }

  // A staging view carries no variant; it is what this tab last created
  // with (`tableId` null until the create resolves), or unknown after a
  // reload.
  let createdVariant = { tableId: null, variant: "classic" };
  function tableVariantOf(_state, id) {
    return createdVariant.tableId === null || createdVariant.tableId === id ? createdVariant.variant : "classic";
  }

  // ── Overlays ───────────────────────────────────────────────────────────

  function aiPicker() {
    const back = start.purpose === "add-bot" || start.purpose === "bot" ? "picker-close" : "picker-back";
    let body;
    if (bots === null) body = `<p class="faint center">Loading bots…</p>`;
    else if ("error" in bots) body = `<p class="alert-text center">Could not load bots.</p>`;
    else if (bots.length === 0) body = `<p class="faint center">No bots have registered with this game yet.</p>`;
    else {
      const cards = bots.flatMap((b) =>
        b.complexities.map((c) => {
          const ch = characterOf(c.complexity);
          const cfg = DIFFICULTY[ch.difficulty];
          const elo = c.elo.length === 1 ? `<span class="faint mono tiny">ELO ${c.elo[0]}</span>` : "";
          return `<button type="button" class="pick-card ${cfg.tone}" data-op="pick-bot" data-bot="${esc(b.principal.toString())}" data-bot-name="${esc(b.name)}" data-complexity="${esc(c.complexity)}">
            <span class="avatar" role="img" aria-label="${esc(ch.name)}">${ch.emoji}</span>
            <span class="pick-title">${esc(ch.name)}</span>
            <span class="pill ${cfg.tone} tight">${esc(cfg.label)}</span>
            <span class="stars" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= cfg.stars ? "on" : ""}">★</i>`).join("")}</span>
            <span class="flavor">${esc(cfg.flavor)}</span>
            <span class="faint mono tiny">${esc(b.name)}</span>
            ${elo}
            <span class="cta ${cfg.tone}">Play vs ${esc(ch.name)} →</span>
          </button>`;
        }),
      );
      body = `<div class="pick-cards">${cards.join("")}</div>`;
    }
    return modal(
      `<button type="button" class="corner-btn" data-op="${back}" aria-label="Close">${back === "picker-back" ? "←" : "✕"}</button>
      <div class="modal-head">
        <span class="text-4xl" role="img" aria-label="opponent">🎮</span>
        <h2>Choose Your Opponent</h2>
        <p class="faint mono">Pick an AI character to play against</p>
      </div>
      ${body}`,
      { cls: "wide glow-primary" },
    );
  }

  function ruleSelect() {
    const cards = RULE_SETS.map(
      (rs) => `<button type="button" class="pick-card rules ${rs.tone}" data-op="pick-rules" data-variant="${rs.key}">
        <span class="rule-head"><span class="text-2xl" role="img">${rs.emoji}</span><span><b>${esc(rs.title)}</b><small>${esc(rs.tagline)}</small></span></span>
        <ul>${rs.rules.map((r) => `<li><span>▸</span>${esc(r)}</li>`).join("")}</ul>
        <span class="split-note">${esc(rs.splitNote)}</span>
        <span class="cta ${rs.tone}">Play with these rules →</span>
      </button>`,
    ).join("");
    const friendOptions =
      start.purpose === "friend"
        ? `<div class="friend-options">
            <fieldset><legend>You play as</legend>
              <label><input type="radio" name="op-seat" value="p1" checked /> ${esc(SEAT_NAME.p1)}</label>
              <label><input type="radio" name="op-seat" value="p2" /> ${esc(SEAT_NAME.p2)}</label>
            </fieldset>
            <fieldset><legend>Table</legend>
              <label><input type="radio" name="op-visibility" value="open" checked /> Open</label>
              <label><input type="radio" name="op-visibility" value="code" /> Code</label>
              <input type="text" id="op-code" placeholder="access code" autocomplete="off" hidden />
            </fieldset>
          </div>`
        : "";
    const back = start.purpose === "friend" ? "picker-close" : "picker-back";
    return modal(
      `<button type="button" class="corner-btn" data-op="${back}" aria-label="Back">${back === "picker-back" ? "←" : "✕"}</button>
      <div class="modal-head">
        <span class="text-4xl" role="img" aria-label="game">✋</span>
        <h2>Choose Your Rules</h2>
        <p class="faint mono">${start.purpose === "friend" ? "Select a rule set to open a table" : "Select a rule set to start the game"}</p>
      </div>
      ${friendOptions}
      <div class="pick-cards">${cards}</div>`,
      { cls: "wide glow-primary" },
    );
  }

  function splitModal(game, me) {
    const variant = variantOf(game);
    const cur = handsOf(game, me);
    const total = cur.l + cur.r;
    if (variant === "instructables") {
      const live = cur.l > 0 ? cur.l : cur.r;
      const half = Math.floor(live / 2);
      const col = (value, tone, side) => `<span class="split-col"><b class="${tone}">${value}</b><small>${side}</small></span>`;
      return modal(
        `<p class="lbl center">Split Evenly</p>
        <p class="faint mono tiny center">Instructables rules — only one valid split</p>
        <div class="split-before-after">
          <span class="split-stage"><small>Before</small><span>${col(cur.l, "muted", "L")}<i>+</i>${col(cur.r, "muted", "R")}</span></span>
          <span class="arrow tap">→</span>
          <span class="split-stage"><small>After</small><span>${col(half, "tap", "L")}<i>+</i>${col(half, "tap", "R")}</span></span>
        </div>
        <div class="row">
          <button type="button" class="btn-action outline" data-op="split-cancel">Cancel</button>
          <button type="button" class="btn-action tap" data-op="split-confirm" data-l="${half}" data-r="${half}" data-key='act:{"split":{"l":${half},"r":${half}}}'>Split Evenly</button>
        </div>`,
        { z: "z50", cls: "narrow glow-tap", closeOp: "split-cancel" },
      );
    }
    const left = split.left;
    const right = total - left;
    const reason = splitValid(variant, cur, left, right);
    return modal(
      `<p class="lbl center">Redistribute Fingers</p>
      <div class="split-slider">
        <span class="split-col big"><b class="tap" id="split-left">${left}</b><small>Left</small></span>
        <input type="range" id="split-range" min="0" max="${total}" value="${left}" aria-label="Distribute fingers between hands" style="${sliderStyle(left, total)}" />
        <span class="split-col big"><b class="secondary" id="split-right">${right}</b><small>Right</small></span>
      </div>
      <p class="faint mono tiny center" id="split-note" ${reason === null ? "hidden" : ""}>${esc(reason ?? "")}</p>
      <div class="row">
        <button type="button" class="btn-action outline" data-op="split-cancel">Cancel</button>
        <button type="button" class="btn-action tap" id="split-confirm" data-op="split-confirm" data-l="${left}" data-r="${right}" data-key='act:{"split":{"l":${left},"r":${right}}}' ${reason === null ? "" : "disabled"}>Confirm Split</button>
      </div>`,
      { z: "z50", cls: "narrow glow-tap", closeOp: "split-cancel" },
    );
  }

  function sliderStyle(left, total) {
    const pct = total === 0 ? 0 : (left / total) * 100;
    return `background:linear-gradient(to right, oklch(0.75 0.25 195) 0%, oklch(0.75 0.25 195) ${pct}%, oklch(0.65 0.28 318) ${pct}%, oklch(0.65 0.28 318) 100%)`;
  }

  function verdictOf(end, me, opp) {
    const t = tag(end);
    if (t === "finished") {
      const who = tag(end.finished);
      if (who === `${me}Wins`) return { win: true, title: "You Win!", note: `You eliminated ${opp.name}'s hands. Well played!` };
      if (who === "draw") return { win: false, title: "It's a draw", note: "Nobody got the upper hand." };
      return { win: false, title: `${opp.name} Wins!`, note: `${opp.name} eliminated both your hands. Try again!` };
    }
    if (t === "claimed") {
      return tag(end.claimed) === me
        ? { win: true, title: "You Win!", note: `${opp.name} didn't move in time.` }
        : { win: false, title: `${opp.name} Wins!`, note: "You didn't move in time." };
    }
    return tag(end.aborted) === me
      ? { win: false, title: `${opp.name} Wins!`, note: "You forfeited the game." }
      : { win: true, title: "You Win!", note: `${opp.name} forfeited the game.` };
  }

  function gameOver(id, v) {
    const me = tag(v.seat);
    const opp = opponentOf(id, oppSeatOf(me));
    const { win, title, note } = verdictOf(v.end, me, opp);
    const tone = win ? "tap" : "secondary";
    return modal(
      `<div class="glow-ring ${tone}"><span class="text-5xl" role="img" aria-label="${win ? "trophy" : "skull"}">${win ? "🏆" : "💀"}</span></div>
      <h2 class="verdict ${tone}">${esc(title)}</h2>
      <p class="faint">${esc(note)}</p>
      <button type="button" class="btn-action ${tone} full big" data-op="rematch" data-key="rematch">Play Again</button>
      <button type="button" class="btn-text" data-op="leave" data-key="leave">Back to lobby</button>`,
      { cls: `narrow game-over ${tone}` },
    );
  }

  // Shown the instant a bot invite starts, before the staged table (which
  // would otherwise carry the same message) has come back from the host.
  function botInviteModal() {
    const ch = characterOf(pendingBotInvite.bot.complexity);
    return modal(
      `<div class="modal-head">
        <span class="text-4xl" role="img" aria-label="${esc(ch.name)}">${ch.emoji}</span>
        <h2>Inviting ${esc(ch.name)}…</h2>
        <p class="faint mono">Setting up your table</p>
      </div>`,
      { cls: "glow-primary" },
    );
  }

  function tutorialModal() {
    const step = tutorial.step;
    const s = TUTORIAL_STEPS[step];
    const last = step === TUTORIAL_STEPS.length - 1;
    return modal(
      `<div class="tut-head">
        <span class="text-3xl" role="img" aria-label="hand">✋</span>
        <div><h2>How to Play</h2><p class="faint mono tiny">Chopsticks — The Hand Game</p></div>
      </div>
      <div class="tut-body">
        <div class="tut-progress">${TUTORIAL_STEPS.map((t, i) => `<button type="button" data-op="tut-step" data-step="${i}" class="${i <= step ? "on" : ""}" aria-label="Go to step ${i + 1}"></button>`).join("")}</div>
        <div class="tut-step" data-step="${step}">
          <div class="tut-icon"><span class="text-4xl" role="img">${s.icon}</span></div>
          <h3>${esc(s.title)}</h3>
          <p>${esc(s.desc)}</p>
        </div>
        <div class="tut-hint"><span class="text-lg">🎮</span><p><b class="tap">Classic:</b> ≥5 eliminates. <b class="secondary">Instructables:</b> exactly 5 kills, above 5 wraps around. Choose your rules before each game!</p></div>
      </div>
      <div class="tut-foot">
        ${
          last
            ? `<button type="button" class="btn-action accent full big" data-op="tut-dismiss">Got it! Let's Play 🎮</button>`
            : `<button type="button" class="btn-action muted" data-op="tut-dismiss">Skip</button>
               <button type="button" class="btn-action accent" data-op="tut-next">Next →</button>`
        }
      </div>`,
      { z: "z50", cls: "tutorial glow-accent", closeOp: "tut-dismiss" },
    );
  }

  function leaderboardModal() {
    let body;
    if ("loading" in leaderboard) body = `<p class="faint center">Loading…</p>`;
    else if ("error" in leaderboard) body = `<p class="alert-text center">Could not load the leaderboard.</p>`;
    else if (leaderboard.entries.length === 0) {
      body = `<div class="lb-empty"><span class="text-4xl" role="img">📊</span><p>No players yet. Be the first!</p></div>`;
    } else {
      const you = playerKeyOf(client.sid);
      const rows = leaderboard.entries.map((e, i) => {
        const bot = parseCanisterPlayer(e.player);
        const isMe = e.player === you;
        let name;
        let challenge = "";
        if (bot !== null) {
          const ch = characterOf(bot.complexity);
          const botName = leaderboard.botNames.get(bot.principal);
          name = `${ch.emoji} ${esc(ch.name)}${botName ? `<small class="faint mono"> ${esc(botName)}</small>` : ""}`;
          if (botName) {
            challenge = `<button type="button" class="btn-small primary" data-op="challenge" data-bot="${esc(bot.principal)}" data-bot-name="${esc(botName)}" data-complexity="${esc(bot.complexity)}">Challenge</button>`;
          }
        } else {
          name = `<span title="${esc(e.player)}">${esc(truncatePlayerId(e.player).text)}</span>${isMe ? `<small class="you-tag">you</small>` : ""}`;
        }
        return `<tr class="${isMe ? "me" : ""}">
          <td><span class="rank r${i < 3 ? i + 1 : "n"}">${i + 1}</span></td>
          <td class="player">${name}</td>
          <td class="num primary">${e.score}</td>
          <td class="act">${challenge}</td>
        </tr>`;
      });
      body = `<table class="lb-table" aria-label="Leaderboard table">
        <thead><tr><th>#</th><th>Player</th><th class="num primary">ELO</th><th></th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
    }
    return modal(
      `<div class="lb-head">
        <div><span class="text-2xl" role="img" aria-label="trophy">🏆</span><div><h2>Leaderboard</h2><p class="faint mono tiny">All-time rankings</p></div></div>
        <button type="button" class="corner-btn static" data-op="lb-close" aria-label="Close leaderboard">✕</button>
      </div>
      <div class="lb-body">${body}</div>`,
      { z: "z60", cls: "leaderboard glow-primary", closeOp: "lb-close" },
    );
  }

  function renderOverlay(state) {
    const parts = [];
    const { status } = state;
    if (start !== null) parts.push(start.step === "ai-picker" ? aiPicker() : ruleSelect());
    else if (pendingBotInvite !== null && stagingOf(status) === null) parts.push(botInviteModal());
    const live = viewOf(status, "inGame");
    if (split !== null && live !== null) parts.push(splitModal(live.game, tag(live.seat)));
    const done = viewOf(status, "debrief");
    if (done !== null && anim === null && start === null) parts.push(gameOver(atTableOf(status).id, done));
    if (tutorial !== null) parts.push(tutorialModal());
    if (leaderboard !== null) parts.push(leaderboardModal());
    return parts.join("");
  }

  // ── Clocks: patched in place once a second, never a redraw ──────────────

  function syncClocks(state) {
    const at = state.statusAt;
    for (const el of document.querySelectorAll("[data-clock]")) {
      const base = BigInt(el.dataset.base ?? "0");
      switch (el.dataset.clock) {
        case "wait":
          el.textContent = `waiting ${localSecondsElapsed(base, at)}s`;
          break;
        case "busy":
          el.textContent = `${localSecondsLeft(base, at)}s until it can be taken over`;
          break;
        case "reclaim": {
          const left = localSecondsLeft(base, at);
          el.hidden = left > RECLAIM_WARNING_SECS;
          el.textContent = `Still there? This seat may be given to someone else ${left <= 0n ? "any moment now" : `in ${left}s`} if the page stays idle.`;
          break;
        }
        case "idle": {
          const left = localSecondsLeft(base, at);
          el.hidden = left > IDLE_WARNING_SECS;
          el.textContent = `Still thinking? This game will be interrupted ${left <= 0n ? "any moment now" : `in ${left}s`} if nobody moves.`;
          break;
        }
        case "claim": {
          const left = localSecondsLeft(base, at);
          const waiting = el.dataset.role === "waiting";
          el.hidden = (waiting && left <= 0n) || left > CLAIM_WARNING_SECS;
          el.textContent = waiting
            ? `Your opponent hasn't moved. You'll be able to claim the win ${left <= 0n ? "now" : `in ${left}s`} if they still haven't.`
            : `You haven't moved yet. Your opponent can claim the win ${left <= 0n ? "now" : `in ${left}s`} if you don't.`;
          break;
        }
        case "claim-button":
          el.hidden = localSecondsLeft(base, at) > 0n;
          break;
      }
    }
  }

  // ── Move history and the opponent-move replay ──────────────────────────

  function snapshot(game, me) {
    const mine = handsOf(game, me);
    const theirs = handsOf(game, oppSeatOf(me));
    return { oppLeft: theirs.l, oppRight: theirs.r, youLeft: mine.l, youRight: mine.r };
  }

  // The one ply between two consecutive positions. Player 1 plays the even
  // plies. An attacker hand is the one whose count explains the change;
  // two equal hands are indistinguishable and the left is named.
  function inferMove(prevGame, nextGame, ply) {
    const mover = ply % 2n === 0n ? "p1" : "p2";
    const victim = oppSeatOf(mover);
    const variant = variantOf(nextGame);
    const pv = handsOf(prevGame, victim);
    const nv = handsOf(nextGame, victim);
    const pm = handsOf(prevGame, mover);
    const nm = handsOf(nextGame, mover);
    for (const to of SIDES) {
      if (pv[to] !== nv[to]) {
        const from = SIDES.find((h) => pm[h] > 0 && hit(variant, pv[to], pm[h]) === nv[to]) ?? "l";
        return { ply, mover, kind: "attack", from, to };
      }
    }
    return { ply, mover, kind: "split", l: nm.l, r: nm.r };
  }

  function clearAnim() {
    clearTimeout(animTimer);
    animTimer = null;
    anim = null;
  }

  function startAnim(move, game) {
    clearAnim();
    anim = { phase: "source", move, game };
    animTimer = setTimeout(() => {
      anim = { ...anim, phase: "target" };
      redraw(client.getState());
      animTimer = setTimeout(() => {
        clearAnim();
        redraw(client.getState());
      }, ANIM_TARGET_MS);
    }, ANIM_SOURCE_MS);
  }

  function trackGame(state) {
    const at = atTableOf(state.status);
    const live = viewOf(state.status, "inGame");
    const done = viewOf(state.status, "debrief");
    const game = live ? live.game : done ? done.finalGame : null;
    if (at === null || game === null) {
      if (history.key !== null) history = { key: null, game: null, turn: null, moves: [] };
      clearAnim();
      return;
    }
    const me = tag((live ?? done).seat);
    const turn = live ? live.turn : done.turns;
    const key = `${at.id}:${(live ?? done).gen}`;
    if (history.key !== key) {
      history = { key, game, turn, moves: [] };
      clearAnim();
      mode = "idle";
      selected = null;
      split = null;
      return;
    }
    if (turn === history.turn + 1n) {
      const move = inferMove(history.game, game, history.turn);
      history.moves.push({ ...move, you: move.mover === me, before: snapshot(history.game, me), after: snapshot(game, me) });
      if (move.mover !== me) startAnim(move, history.game);
    }
    history.game = game;
    history.turn = turn;
    if (live && live.youSubmitted) {
      mode = "idle";
      selected = null;
      split = null;
    }
  }

  function countEnding(state) {
    const at = atTableOf(state.status);
    const done = viewOf(state.status, "debrief");
    if (at === null || done === null) return;
    const key = `${at.id}:${done.gen}:${done.turns}`;
    if (record.last === key) return;
    const me = tag(done.seat);
    const t = tag(done.end);
    let outcome;
    if (t === "finished") {
      const who = tag(done.end.finished);
      outcome = who === "draw" ? "draws" : who === `${me}Wins` ? "wins" : "losses";
    } else if (t === "claimed") outcome = tag(done.end.claimed) === me ? "wins" : "losses";
    else outcome = tag(done.end.aborted) === me ? "losses" : "wins";
    record = { ...record, [outcome]: record[outcome] + 1, last: key };
    storageSet(recordKey, record);
  }

  // ── Bots ───────────────────────────────────────────────────────────────

  async function loadBots() {
    bots = null;
    redraw(client.getState());
    try {
      bots = await services.listBots();
    } catch (err) {
      console.error(err);
      bots = { error: true };
    }
    redraw(client.getState());
  }

  async function inviteBot(bot, staging) {
    pendingBotInvite = { bot, stage: "inviting" };
    redraw(client.getState());
    try {
      const res = await services.playBot(bot.principalText, staging.tableId, staging.openSeat, staging.code, bot.complexity);
      if ("err" in res) throw new Error(errText(res.err));
      // The bot's join pushes a fresh status to this connection on its own;
      // the invite stays on screen until that status lands.
      setLastBot({ ...bot, tableId: staging.tableId });
      pendingBotInvite = { bot, stage: "joining" };
    } catch (e) {
      client.showError(e && e.message ? e.message : String(e));
      pendingBotInvite = null;
    }
    redraw(client.getState());
  }

  async function startBotGame(bot, variant) {
    pendingBotInvite = { bot, stage: "creating" };
    createdVariant = { tableId: null, variant };
    redraw(client.getState());
    const res = await client.createTable("p1", { open: null }, variant);
    const staging = res.ok ? stagingOf(res.view) : null;
    if (staging === null) {
      pendingBotInvite = null;
      if (res.ok) client.showError("Could not stage a table.");
      redraw(client.getState());
      return;
    }
    createdVariant = { tableId: staging.tableId, variant };
    await inviteBot(bot, staging);
  }

  // A rematch against a bot: the reserved staging re-invites the same bot.
  function maybeReinvite(state) {
    if (state.status === null) return;
    const at = atTableOf(state.status);
    const v = viewOf(state.status, "stagingYou");
    if (lastBot && !(at && at.id === lastBot.tableId)) setLastBot(null);
    if (!lastBot || !v || !at || !v.reservedForPartner || pendingBotInvite) return;
    const key = `${at.id}:${v.gen}`;
    if (reinvited === key) return;
    reinvited = key;
    void inviteBot(lastBot, stagingOf(state.status));
  }

  // ── Dialogs ────────────────────────────────────────────────────────────

  const ask = (dialog, resolveWith) =>
    new Promise((resolve) => {
      const finish = (value) => {
        dialog.removeEventListener("click", onClick);
        dialog.removeEventListener("cancel", onCancel);
        if (dialog.open) dialog.close();
        resolve(resolveWith(value));
      };
      const onClick = (ev) => {
        const b = ev.target.closest("button[value]");
        if (!b) return;
        ev.preventDefault();
        finish(b.value);
      };
      const onCancel = (ev) => {
        ev.preventDefault();
        finish("");
      };
      dialog.addEventListener("click", onClick);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
    });
  const confirmForfeit = () => ask(confirmDialog, (rv) => rv === "yes");
  const askCode = () => {
    codeDialog.querySelector("input").value = "";
    return ask(codeDialog, (rv) => (rv === "join" ? codeDialog.querySelector("input").value : null));
  };

  // ── Controls ───────────────────────────────────────────────────────────

  function botOf(b) {
    return { principalText: b.dataset.bot, name: b.dataset.botName || b.dataset.bot, complexity: b.dataset.complexity || "" };
  }

  function openAiPicker(purpose, bot = null) {
    start = { step: "ai-picker", purpose, bot };
    leaderboard = null;
    void loadBots();
  }

  function pickBot(bot) {
    if (start.purpose === "add-bot") {
      const staging = stagingOf(client.getState().status);
      start = null;
      if (staging) void inviteBot(bot, staging);
      return;
    }
    start = { step: "rule-select", purpose: "bot", bot };
  }

  function pickRules(variant) {
    const { purpose, bot } = start;
    if (purpose === "bot") {
      start = null;
      void startBotGame(bot, variant);
      return;
    }
    const seat = overlay.querySelector('input[name="op-seat"]:checked')?.value ?? "p1";
    const coded = overlay.querySelector('input[name="op-visibility"][value="code"]')?.checked ?? false;
    const code = overlay.querySelector("#op-code")?.value ?? "";
    if (coded && code === "") return client.showError("Set an access code, or open the table to everyone.");
    start = null;
    createdVariant = { tableId: null, variant };
    void client.createTable(seat, coded ? { code } : { open: null }, variant).then((res) => {
      const staging = res.ok ? stagingOf(res.view) : null;
      if (staging) createdVariant = { tableId: staging.tableId, variant };
    });
  }

  function dismissTutorial() {
    storageSet(TUTORIAL_KEY, 1);
    tutorial = null;
  }

  async function openLeaderboard() {
    leaderboard = { loading: true };
    redraw(client.getState());
    try {
      const [entries, botList] = await Promise.all([services.leaderboard(), services.listBots().catch(() => [])]);
      leaderboard = { entries, botNames: new Map(botList.map((b) => [b.principal.toString(), b.name])) };
    } catch (err) {
      console.error(err);
      leaderboard = { error: true };
    }
    redraw(client.getState());
  }

  async function onOp(b) {
    const state = client.getState();
    switch (b.dataset.op) {
      case "play-ai":
        return openAiPicker("bot");
      case "play-friend":
        start = { step: "rule-select", purpose: "friend", bot: null };
        return;
      case "add-bot":
        return openAiPicker("add-bot");
      case "challenge":
        start = { step: "rule-select", purpose: "bot", bot: botOf(b) };
        leaderboard = null;
        return;
      case "pick-bot":
        return pickBot(botOf(b));
      case "pick-rules":
        return pickRules(b.dataset.variant);
      case "picker-back":
        start = start.step === "rule-select" && start.purpose === "bot" ? { step: "ai-picker", purpose: "bot", bot: null } : null;
        if (start !== null && bots === null) void loadBots();
        return;
      case "picker-close":
        start = null;
        return;
      case "join": {
        let code = null;
        if ("protected" in b.dataset) {
          code = await askCode();
          if (code === null) return;
        }
        return void client.joinTable(BigInt(b.dataset.table), b.dataset.seat, code);
      }
      case "cancel-target":
        mode = "idle";
        selected = null;
        return;
      case "split-open": {
        const live = viewOf(state.status, "inGame");
        if (!live) return;
        const cur = handsOf(live.game, tag(live.seat));
        mode = "idle";
        selected = null;
        split = { left: Math.floor((cur.l + cur.r) / 2) };
        return;
      }
      case "split-cancel":
        split = null;
        return;
      case "split-confirm":
        split = null;
        return void client.submit({ split: { l: Number(b.dataset.l), r: Number(b.dataset.r) } });
      case "forfeit":
        if (await confirmForfeit()) void client.leave();
        return;
      case "leave":
        return void client.leave();
      case "rematch":
        return void client.rematch();
      case "reset":
        return void client.reset();
      case "claim":
        return void client.claimWin();
      case "ack":
        return void client.ackEnded();
      case "tut-open":
        tutorial = { step: 0 };
        return;
      case "tut-step":
        tutorial = { step: Number(b.dataset.step) };
        return;
      case "tut-next":
        tutorial = { step: Math.min(tutorial.step + 1, TUTORIAL_STEPS.length - 1) };
        return;
      case "tut-dismiss":
        return dismissTutorial();
      case "lb-open":
        return void openLeaderboard();
      case "lb-close":
        leaderboard = null;
        return;
    }
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.disabled || b.closest("dialog")) return;
    const state = client.getState();
    if (b.dataset.act !== undefined) {
      if (state.pending) return;
      mode = "idle";
      selected = null;
      void client.submit(JSON.parse(b.dataset.act));
      redraw(state);
      return;
    }
    if (b.dataset.hand !== undefined) {
      if (state.pending || anim) return;
      selected = selected === b.dataset.hand ? null : b.dataset.hand;
      mode = selected === null ? "idle" : "select-target";
      redraw(state);
      return;
    }
    if (b.dataset.op === undefined) return;
    if (state.pending && b.dataset.key !== undefined) return;
    await onOp(b);
    redraw(client.getState());
  });

  overlay.addEventListener("change", (ev) => {
    if (ev.target.name === "op-visibility") overlay.querySelector("#op-code").hidden = ev.target.value !== "code";
  });

  // The slider is live input: patch the numbers, never redraw under it.
  overlay.addEventListener("input", (ev) => {
    if (ev.target.id !== "split-range" || split === null) return;
    const live = viewOf(client.getState().status, "inGame");
    if (!live) return;
    const cur = handsOf(live.game, tag(live.seat));
    const total = cur.l + cur.r;
    split = { left: Number(ev.target.value) };
    const right = total - split.left;
    ev.target.style.cssText = sliderStyle(split.left, total);
    overlay.querySelector("#split-left").textContent = split.left;
    overlay.querySelector("#split-right").textContent = right;
    const reason = splitValid(variantOf(live.game), cur, split.left, right);
    const note = overlay.querySelector("#split-note");
    note.hidden = reason === null;
    note.textContent = reason ?? "";
    const confirm = overlay.querySelector("#split-confirm");
    confirm.disabled = reason !== null;
    confirm.dataset.l = split.left;
    confirm.dataset.r = right;
    confirm.dataset.key = `act:${JSON.stringify({ split: { l: split.left, r: right } })}`;
  });

  // ── Header ─────────────────────────────────────────────────────────────

  const shortSid = truncatePlayerId(playerKeyOf(client.sid));
  sid.textContent = shortSid.text;
  sid.title = client.sid;
  if (!session.regenerate || session.isLoggedIn) switchBtn.hidden = true;
  else switchBtn.addEventListener("click", () => void client.regenerateSid());
  if (session.login && session.logout) {
    authBtn.textContent = session.isLoggedIn ? "Log out" : "Log in";
    authBtn.hidden = false;
    authBtn.addEventListener("click", () => void (session.isLoggedIn ? client.logout() : client.login()));
  }
  leaderboardBtn.dataset.op = "lb-open";
  tutorialBtn.dataset.op = "tut-open";

  // ── Sync ───────────────────────────────────────────────────────────────

  // Every `data-key`/`data-act` button is disabled while a call is out;
  // the one that issued it spins.
  function syncButtons(state) {
    const key = state.pending?.key ?? null;
    const dead = state.connection === "closed";
    for (const b of document.querySelectorAll("#screen button, #overlay button")) {
      if (b.dataset.naturallyOff === undefined) b.dataset.naturallyOff = b.disabled ? "1" : "0";
      const ownKey = b.dataset.key ?? (b.dataset.act !== undefined ? `act:${b.dataset.act}` : null);
      b.disabled = dead || (key !== null && (ownKey !== null || b.dataset.hand !== undefined)) || b.dataset.naturallyOff === "1";
      b.classList.toggle("spinning", key !== null && ownKey === key);
    }
  }

  function syncAlert(state) {
    if (state.connection === "closed") {
      alert.innerHTML = `Connection lost. <button type="button" id="reload">Reconnect</button>`;
      alert.hidden = false;
      alert.querySelector("#reload").addEventListener("click", () => location.reload());
      return;
    }
    alert.hidden = state.error === null;
    alert.textContent = state.error ?? "";
  }

  function syncIdentity(state) {
    switchBtn.disabled = state.identityLocked;
    authBtn.disabled = state.identityLocked;
  }

  // The friend-table options are live input; keep them across an
  // unrelated redraw (another table appearing in the lobby).
  function redraw(state) {
    const seat = overlay.querySelector('input[name="op-seat"]:checked')?.value;
    const coded = overlay.querySelector('input[name="op-visibility"][value="code"]')?.checked ?? false;
    const code = overlay.querySelector("#op-code")?.value ?? "";
    screen.innerHTML = renderScreen(state);
    const nextOverlayHtml = renderOverlay(state);
    if (nextOverlayHtml !== lastOverlayHtml) {
      overlay.innerHTML = nextOverlayHtml;
      lastOverlayHtml = nextOverlayHtml;
    }
    const seatRadio = seat && overlay.querySelector(`input[name="op-seat"][value="${seat}"]`);
    if (seatRadio) seatRadio.checked = true;
    const codeRadio = overlay.querySelector('input[name="op-visibility"][value="code"]');
    if (codeRadio && coded) {
      codeRadio.checked = true;
      const input = overlay.querySelector("#op-code");
      input.hidden = false;
      input.value = code;
    }
    document.body.classList.toggle("modal-open", overlay.childElementCount > 0);
    syncClocks(state);
    syncButtons(state);
  }

  function onStatus(state) {
    const at = atTableOf(state.status);
    if (start !== null && at !== null && tag(at.view) === "inGame") start = null;
    if (pendingBotInvite !== null && pendingBotInvite.stage === "joining" && tag(at?.view ?? {}) !== "stagingYou") pendingBotInvite = null;
    trackGame(state);
    countEnding(state);
    maybeReinvite(state);
  }

  if (!storageGet(TUTORIAL_KEY)) tutorial = { step: 0 };
  onStatus(client.getState());
  redraw(client.getState());
  syncIdentity(client.getState());
  client.subscribe((state, prev) => {
    if (state.status !== prev.status) onStatus(state);
    if (state.status !== prev.status || state.pending !== prev.pending) redraw(state);
    else syncButtons(state);
    document.body.classList.toggle("working", state.pending !== null);
    if (state.identityLocked !== prev.identityLocked) syncIdentity(state);
    if (state.error !== prev.error || state.connection !== prev.connection) syncAlert(state);
  });
  setInterval(() => syncClocks(client.getState()), 1000);
}
