// Generic view layer: pure functions from a per-caller `Status`/`View` to
// an HTML string. No DOM, no network. Every phase except `inGame`/
// `debrief` is rendered entirely here; those two defer the board and
// action markup to a `GamePlugin` (see types.ts).

import type {
  AwaitingRematchView,
  BotInfo,
  BusyView,
  DebriefView,
  EngineErr,
  GamePlugin,
  InGameView,
  LeaderboardEntry,
  LobbyView,
  SeatTag,
  StagingYouView,
  Status,
  TableSummary,
  View,
} from "./types.js";

export function tag(v: object): string {
  return Object.keys(v)[0];
}

export function val(v: object): unknown {
  return Object.values(v as Record<string, unknown>)[0];
}

export function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

/// Encodes any move value into the `data-act` attribute app.ts decodes
/// back for `submit`, so an `Action` can be any Candid shape.
export function actionAttr(actionValue: unknown): string {
  return `data-act='${esc(JSON.stringify(actionValue))}'`;
}

/// Text for every engine-level `Err`; a game's own `illegalMove` reason
/// is already free text.
export function errText(e: EngineErr): string {
  const t = tag(e);
  const v = val(e);
  switch (t) {
    case "seatTaken":
      return "That seat is already taken.";
    case "notSeated":
      return "You are not seated in this game.";
    case "alreadySubmitted":
      return "You have already moved this round.";
    case "notYourTurn":
      return "It's not your turn.";
    case "illegalMove":
      return v as string;
    case "wrongPhase":
      return v as string;
    case "reserved":
      return `That seat is held for a rematch — ${(v as { secondsLeft: bigint }).secondsLeft}s left.`;
    case "notIdle":
      return `The board is in use — ${(v as { secondsLeft: bigint }).secondsLeft}s until it can be taken over.`;
    case "notOverdue":
      return `Your opponent hasn't gone quiet long enough yet — ${(v as { secondsLeft: bigint }).secondsLeft}s left before you can claim the win.`;
    case "noSuchTable":
      return "That table doesn't exist any more.";
    case "badCode":
      return "Wrong (or missing) access code for that table.";
    case "unauthorized":
      return "This session belongs to a different signed-in identity.";
    default:
      return t;
  }
}

function renderLobby(v: LobbyView, plugin: GamePlugin): string {
  const seatBtn = (seat: SeatTag, open: boolean) => `
    <button class="seat" data-join-table="${seat}" ${open ? "" : "disabled"}>
      <span class="seat-label">${esc(plugin.seatLabel(seat))}</span>
      <span class="muted">${open ? "seat open" : "taken"}</span>
    </button>`;
  return `
    <h2>Choose your seat</h2>
    <div class="seats">
      ${seatBtn("p1", v.p1Open)}
      ${seatBtn("p2", v.p2Open)}
    </div>
    ${
      v.resetAvailable
        ? `<p><button data-reset class="ghost">Clear the abandoned board</button></p>`
        : ""
    }`;
}

// Shared with app.ts's `makeTableWaitTicker`, which patches this text in
// place once a second.
export function waitingText(waitingSecs: bigint): string {
  return `waiting ${waitingSecs}s`;
}

export const PLAYER_ID_MAX_LEN = 16;

export function truncatePlayerId(id: string): { text: string; truncated: boolean } {
  if (id.length <= PLAYER_ID_MAX_LEN) return { text: id, truncated: false };
  return { text: `${id.slice(0, PLAYER_ID_MAX_LEN)}…`, truncated: true };
}

/// Mirrors `Ws.playerKey`: strips `ii:`/`an:` to the bare principal text
/// so a `session.sid` can be compared against `LeaderboardEntry.player`.
export function playerKeyOf(sid: string): string {
  if (sid.startsWith("ii:")) return sid.slice(3);
  if (sid.startsWith("an:")) return sid.slice(3);
  return sid;
}

/// A human's key carries no prefix (stripped server-side before storing);
/// a `cp:` prefix is added back deliberately by a host wiring canister
/// players, so it is the one marker a leaderboard row can carry.
const CANISTER_PLAYER_PREFIX = "cp:";
export function isCanisterPlayer(player: string): boolean {
  return player.startsWith(CANISTER_PLAYER_PREFIX);
}

/// Mirrors `CanisterPlayers.DEFAULT_COMPLEXITY`.
export const DEFAULT_BOT_COMPLEXITY = "Default";

/// Splits `cp:<principal>:<complexity>` (`CanisterPlayers.leaderboardKey`);
/// the complexity is everything after the second `:`. `null` for a human.
export function parseCanisterPlayer(player: string): { principal: string; complexity: string } | null {
  if (!isCanisterPlayer(player)) return null;
  const rest = player.slice(CANISTER_PLAYER_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) return { principal: rest, complexity: DEFAULT_BOT_COMPLEXITY };
  const complexity = rest.slice(sep + 1);
  return { principal: rest.slice(0, sep), complexity: complexity === "" ? DEFAULT_BOT_COMPLEXITY : complexity };
}

/// `"<name> (<complexity>)"`, the complexity always spelled out.
export function botDisplayName(name: string, complexity: string): string {
  return `${name} (${complexity})`;
}

export function displayPlayerId(player: string): string {
  const bot = parseCanisterPlayer(player);
  return bot === null ? player : botDisplayName(bot.principal, bot.complexity);
}

function renderTableRow(r: TableSummary, plugin: GamePlugin): string {
  const seatBtn = (seat: SeatTag, open: boolean, occupantOpt: [] | [string]) => {
    const occupantHtml = (() => {
      if (open || occupantOpt.length === 0) return "";
      const occupant = occupantOpt[0];
      const { text, truncated } = truncatePlayerId(occupant);
      const title = truncated ? ` title="${esc(occupant)}"` : "";
      return `<span class="seat-occupant"${title}>${esc(text)}</span>`;
    })();
    // A bare `data-protected` tells app.ts to prompt for the access code
    // before dispatching the same `joinTable` an open row sends directly.
    return `
    <button class="seat" data-join-table-id="${r.id}" data-join-table="${seat}"${r.protected ? " data-protected" : ""} ${open ? "" : "disabled"}>
      <span class="seat-label">${esc(plugin.seatLabel(seat))}</span>
      ${occupantHtml}
    </button>`;
  };
  // Empty for a game without variants (`variant` is always ""). A plugin
  // without `formatVariant` still shows the raw key rather than nothing.
  const variantHtml = r.variant
    ? ` <span class="variant-badge">${esc(plugin.formatVariant ? plugin.formatVariant(r.variant) : r.variant)}</span>`
    : "";
  return `
    <div class="table-row">
      <span class="table-id">Table #${r.id}${r.protected ? ` <span class="protected-badge" title="Requires an access code">🔒 Protected</span>` : ""}${variantHtml}</span>
      <span class="muted" data-wait-base="${r.waitingSecs}">${waitingText(r.waitingSecs)}</span>
      <div class="table-row-seats">
        ${seatBtn("p1", r.p1Open, r.p1Session)}
        ${seatBtn("p2", r.p2Open, r.p2Session)}
      </div>
    </div>`;
}

function renderBrowsing(v: { tables: TableSummary[] }, plugin: GamePlugin): string {
  const seatBtn = (seat: SeatTag) => `
    <button class="seat" data-create-table="${seat}">${esc(plugin.seatLabel(seat))}</button>`;
  // No picker for a game without `variantChoices`; the first choice is the
  // default, read back by app.ts's `readCreateVariant`.
  const choices = plugin.variantChoices?.() ?? [];
  const variantPicker =
    choices.length === 0
      ? ""
      : `
      <div class="table-variant-choices">
        ${choices
          .map(
            (c, i) => `
        <label><input type="radio" name="table-variant" value="${esc(c.key)}"${i === 0 ? " checked" : ""} /> ${esc(c.label)}</label>`
          )
          .join("")}
      </div>`;
  return `
    <h2>Duel lobby</h2>

    <section class="create-table">
      <h3>Start a new table</h3>
      <label><input type="radio" name="table-visibility" value="open" checked /> Open — anyone can join</label>
      <label><input type="radio" name="table-visibility" value="code" /> Protected — share a code with a friend</label>
      <input type="text" id="create-code" class="table-code-input" placeholder="access code" hidden />
      ${variantPicker}
      <div class="seats">
        ${seatBtn("p1")}
        ${seatBtn("p2")}
      </div>
    </section>

    <section class="open-tables">
      <h3>Tables</h3>
      ${
        v.tables.length === 0
          ? `<p class="muted">No tables right now — start one above.</p>`
          : v.tables.map((r) => renderTableRow(r, plugin)).join("")
      }
    </section>`;
}

function renderBusy(v: BusyView): string {
  return `
    <h2>Board in use</h2>
    <p>Another game is under way.</p>
    <p class="countdown">${v.secondsUntilTakeover}s until it can be taken over</p>`;
}

// Warns a staged occupant their seat is about to become reclaimable.
// Rendered unconditionally (just `hidden`) so app.ts's countdown ticker
// has a stable element to patch between pushes.
export const DUEL_RECLAIM_WARNING_ID = "duel-reclaim-warning";
export const RECLAIM_WARNING_SECS = 15n;

export function reclaimWarningText(secondsUntilReclaimable: bigint): string {
  const when =
    secondsUntilReclaimable <= 0n ? "any moment now" : `in ${secondsUntilReclaimable}s`;
  return `Still there? This seat may be given to someone else ${when} if the page stays idle.`;
}

function renderStagingYou(v: StagingYouView, plugin: GamePlugin): string {
  const seat = tag(v.seat) as SeatTag;
  const reclaimWarningHidden = v.secondsUntilReclaimable > RECLAIM_WARNING_SECS;
  // A protected table's code, present only on the occupant's own view.
  const code = "code" in v.visibility ? v.visibility.code : null;
  return `
    <h2>Waiting for an opponent</h2>
    <p>You hold <strong class="seat-label">${esc(plugin.seatLabel(seat))}</strong>.</p>
    ${
      v.reservedForPartner
        ? `<p class="muted">The other seat is held for your last opponent for
             a while — after that anyone may take it.</p>`
        : code !== null
          ? `<p class="muted"><strong>Protected</strong> — share this table's
               number above and the code <code class="table-code">${esc(code)}</code>
               with a friend. Nobody else can join.</p>`
          : `<p class="muted">Open this page in another tab to take the other
               seat.</p>`
    }
    <p class="countdown" id="${DUEL_RECLAIM_WARNING_ID}"${reclaimWarningHidden ? " hidden" : ""}>${reclaimWarningText(v.secondsUntilReclaimable)}</p>
    <p><button data-leave class="ghost">Leave</button></p>`;
}

function renderAwaitingRematch(v: AwaitingRematchView, plugin: GamePlugin): string {
  const seat = tag(v.openSeat) as SeatTag;
  return `
    <h2>Rematch offered</h2>
    <p>
      Your last opponent wants another game and has held
      <strong class="seat-label">${esc(plugin.seatLabel(seat))}</strong> for you.
    </p>
    <p>
      <button data-rematch class="primary">Accept rematch</button>
      <button data-leave class="ghost">Decline</button>
    </p>
    <p class="muted">Decline (or ignore it) and the seat opens to anyone.</p>`;
}

// The in-game idle warning. Threshold scales with the table's own timeout.
export const DUEL_IDLE_WARNING_ID = "duel-idle-warning";

export function idleWarningThreshold(idleTimeoutSecs: bigint): bigint {
  const half = idleTimeoutSecs / 2n;
  return half < 30n ? half : 30n;
}

export function idleWarningText(secondsUntilIdleReset: bigint): string {
  const when =
    secondsUntilIdleReset <= 0n ? "any moment now" : `in ${secondsUntilIdleReset}s`;
  return `Still thinking? This game will be interrupted ${when} if nobody moves.`;
}

// The claim clock, seen from two roles: "waiting" (my move is in, the
// opponent's is overdue — offers the claim) and "atRisk" (the mirror; no
// button). At most one of these and the idle warning shows at a time.
export const DUEL_CLAIM_WARNING_ID = "duel-claim-warning";
export const DUEL_CLAIM_BUTTON_ID = "duel-claim-button";

export function claimWarningThreshold(claimTimeoutSecs: bigint): bigint {
  const half = claimTimeoutSecs / 2n;
  return half < 15n ? half : 15n;
}

export function claimWarningText(secondsUntilClaimable: bigint): string {
  const when = secondsUntilClaimable <= 0n ? "now" : `in ${secondsUntilClaimable}s`;
  return `Your opponent hasn't moved. You'll be able to claim the win ${when} if they still haven't.`;
}

export function atRiskWarningText(secondsUntilClaimable: bigint): string {
  const when = secondsUntilClaimable <= 0n ? "now" : `in ${secondsUntilClaimable}s`;
  return `You haven't moved yet. Your opponent can claim the win ${when} if you don't.`;
}

function renderInGame<S>(v: InGameView<S>, plugin: GamePlugin<S>): string {
  const mySeat = tag(v.seat) as SeatTag;
  const oppSeat: SeatTag = mySeat === "p1" ? "p2" : "p1";
  const alternating = "alternating" in v.mode;
  // A player who already locked in can't do anything about the idle clock.
  const idleWarningHidden =
    v.youSubmitted || v.secondsUntilIdleReset > idleWarningThreshold(v.idleTimeoutSecs);
  const claimRole: "waiting" | "atRisk" | null = v.youSubmitted
    ? (v.oppSubmitted ? null : "waiting")
    : (v.oppSubmitted ? "atRisk" : null);

  return `
    <div class="turnbar">
      <span>${alternating ? "Move" : "Round"} <strong>${v.turn + 1n}</strong></span>
      <span class="${v.oppSubmitted ? "locked" : "muted"}">${
        alternating
          ? v.oppSubmitted
            ? "◉ Your turn"
            : "○ Opponent's turn"
          : v.oppSubmitted
            ? "◉ Opponent has locked in"
            : "○ Opponent is deciding"
      }</span>
    </div>
    <div class="board">${plugin.renderBoard(v.game, mySeat, oppSeat, !v.youSubmitted)}</div>
    ${
      v.youSubmitted
        ? `<p class="waiting">${alternating ? "Waiting for your opponent's turn…" : "Move locked in — waiting for your opponent…"}</p>`
        : `<div class="actions">${plugin.renderActions(v.game, mySeat)}</div>`
    }
    <p class="countdown" id="${DUEL_IDLE_WARNING_ID}"${idleWarningHidden ? " hidden" : ""}>${idleWarningText(v.secondsUntilIdleReset)}</p>
    ${
      claimRole === null
        ? ""
        : (() => {
            // Once claimable, the "waiting" text steps aside for the button.
            const text =
              claimRole === "waiting"
                ? claimWarningText(v.secondsUntilClaimable)
                : atRiskWarningText(v.secondsUntilClaimable);
            const claimTextHidden =
              (claimRole === "waiting" && v.claimWinAvailable) ||
              v.secondsUntilClaimable > claimWarningThreshold(v.claimTimeoutSecs);
            const button =
              claimRole === "waiting"
                ? `\n           <p><button id="${DUEL_CLAIM_BUTTON_ID}" data-claim-win class="primary"${v.claimWinAvailable ? "" : " hidden"}>Claim the win</button></p>`
                : "";
            return `<p class="countdown" id="${DUEL_CLAIM_WARNING_ID}"${claimTextHidden ? " hidden" : ""}>${text}</p>${button}`;
          })()
    }
    <p><button data-leave data-confirm="Forfeit this game? Your opponent will win." class="ghost">Forfeit</button></p>`;
}

function renderDebrief<S>(v: DebriefView<S>, plugin: GamePlugin<S>): string {
  const mySeat = tag(v.seat) as SeatTag;
  const oppSeat: SeatTag = mySeat === "p1" ? "p2" : "p1";
  let title: string;
  let cls: string;
  const endTag = tag(v.end);
  if (endTag === "finished") {
    const verdict = tag(val(v.end) as object);
    if (verdict === "draw") {
      title = "It's a draw";
      cls = "draw";
    } else if (verdict === `${mySeat}Wins`) {
      title = "You win";
      cls = "win";
    } else {
      title = "You lose";
      cls = "lose";
    }
  } else if (endTag === "claimed") {
    const claimant = tag(val(v.end) as object);
    if (claimant === mySeat) {
      title = "You win — your opponent didn't move in time";
      cls = "win";
    } else {
      title = "You lose — you didn't move in time";
      cls = "lose";
    }
  } else {
    title =
      tag(val(v.end) as object) === mySeat
        ? "You walked away"
        : "Your opponent walked away";
    cls = "draw";
  }

  return `
    <h2 class="verdict ${cls}">${title}</h2>
    <p class="muted">Game lasted ${v.turns} round${v.turns === 1n ? "" : "s"}.</p>
    <div class="board">${plugin.renderBoard(v.finalGame, mySeat, oppSeat)}</div>
    <p>
      <button data-rematch class="primary">Rematch</button>
      <button data-leave class="ghost">Return to lobby</button>
    </p>`;
}

function renderEndedByOther(): string {
  return `
    <h2>Your game was ended</h2>
    <p>The board sat idle too long and was reclaimed. Your game is gone.</p>
    <p><button data-ack class="primary">Return to lobby</button></p>`;
}

/// One table's `View` -> HTML. Reached via `renderStatus`'s `atTable`.
export function renderView<S>(view: View<S>, plugin: GamePlugin<S>): string {
  const t = tag(view as object);
  const v = val(view as object);
  switch (t) {
    case "lobby":
      return renderLobby(v as LobbyView, plugin);
    case "busy":
      return renderBusy(v as BusyView);
    case "stagingYou":
      return renderStagingYou(v as StagingYouView, plugin);
    case "awaitingRematch":
      return renderAwaitingRematch(v as AwaitingRematchView, plugin);
    case "inGame":
      return renderInGame(v as InGameView<S>, plugin);
    case "debrief":
      return renderDebrief(v as DebriefView<S>, plugin);
    case "endedByOther":
      return renderEndedByOther();
    default:
      return `<p class="error">Unknown view: ${esc(t)}</p>`;
  }
}

/// `Status` -> HTML, the top-level entry point.
export function renderStatus<S>(status: Status<S>, plugin: GamePlugin<S>): string {
  const t = tag(status as object);
  const v = val(status as object);
  switch (t) {
    case "browsing":
      return renderBrowsing(v as { tables: TableSummary[] }, plugin);
    case "atTable": {
      const { id, view } = v as { id: bigint; view: View<S> };
      return `<div class="table-badge">Table #${id}</div>${renderView(view, plugin)}`;
    }
    default:
      return `<p class="error">Unknown status: ${esc(t)}</p>`;
  }
}

/// Renders a ranked `get_leaderboard()` result. Never wired into
/// `renderStatus`; a game mounts it itself. `opts.yourSid` badges the
/// caller's row; a canister player's row shows 🤖, `"<name or principal>
/// (<complexity>)"` (name from `opts.botNames`, keyed by principal text),
/// the raw key in `title`, and a Challenge button carrying that row's
/// complexity. See ../README.md, "Leaderboard".
export function renderLeaderboard(
  entries: LeaderboardEntry[],
  plugin: GamePlugin,
  opts?: { yourSid?: string; botNames?: Map<string, string> },
): string {
  if (entries.length === 0) {
    return `<p class="muted">No games finished yet — the leaderboard is empty.</p>`;
  }
  const you = opts?.yourSid !== undefined ? playerKeyOf(opts.yourSid) : undefined;
  const format = plugin.formatScore ?? ((score: bigint) => score.toString());
  const rows = entries
    .map((e, i) => {
      // The full id is rendered and left to CSS to clip; `title` is
      // unconditional since clipping depends on the viewer's width.
      const isYou = you !== undefined && e.player === you;
      const bot = parseCanisterPlayer(e.player);
      const botIcon = bot !== null ? `<span class="leaderboard-bot-icon" title="Canister player">🤖</span>` : "";
      const botName = bot !== null ? (opts?.botNames?.get(bot.principal) ?? bot.principal) : "";
      const displayName = bot !== null ? botDisplayName(botName, bot.complexity) : e.player;
      const challengeBtn =
        bot !== null
          ? `<button type="button" class="leaderboard-challenge" data-challenge-bot="${esc(bot.principal)}" data-bot-name="${esc(botName)}" data-bot-complexity="${esc(bot.complexity)}">Challenge</button>`
          : "";
      return `
    <div class="leaderboard-row${isYou ? " you" : ""}">
      <span class="leaderboard-rank">${i + 1}</span>
      <span class="leaderboard-player" title="${esc(e.player)}">${botIcon}${esc(displayName)}</span>
      ${isYou ? `<span class="leaderboard-you-badge">You</span>` : ""}
      <span class="leaderboard-score">${esc(format(e.score))}</span>
      ${challengeBtn}
    </div>`;
    })
    .join("");
  return `<div class="leaderboard">${rows}</div>`;
}

/// Renders `list_bots()`: one row per bot AND complexity, in declared
/// order, each with the same Challenge attributes `renderLeaderboard`'s
/// bot rows carry, so a game wires one click handler for both.
export function renderBotList(bots: BotInfo[], plugin: GamePlugin): string {
  if (bots.length === 0) {
    return `<p class="muted">No bots have registered with this game yet.</p>`;
  }
  const format = plugin.formatScore ?? ((score: bigint) => score.toString());
  const rows = bots
    .flatMap((b) => {
      const principalText = b.principal.toString();
      return b.complexities.map((c) => {
        const eloText =
          c.elo.length === 1 ? `<span class="leaderboard-score">${esc(format(c.elo[0]))}</span>` : "";
        return `
    <div class="leaderboard-row">
      <span class="leaderboard-player" title="${esc(principalText)}">🤖 ${esc(botDisplayName(b.name, c.complexity))}</span>
      ${eloText}
      <button type="button" class="leaderboard-challenge" data-challenge-bot="${esc(principalText)}" data-bot-name="${esc(b.name)}" data-bot-complexity="${esc(c.complexity)}">Challenge</button>
    </div>`;
      });
    })
    .join("");
  return `<div class="leaderboard">${rows}</div>`;
}

/// The seat picker a challenge dialog (outside `#screen`) shows before
/// creating a table for a bot. Buttons carry `data-challenge-seat`.
export function renderSeatChoice(plugin: GamePlugin): string {
  const seatBtn = (seat: SeatTag) => `
    <button type="button" class="seat" data-challenge-seat="${seat}">${esc(plugin.seatLabel(seat))}</button>`;
  return `
    <p>Choose your seat:</p>
    <div class="seats">
      ${seatBtn("p1")}
      ${seatBtn("p2")}
    </div>`;
}
