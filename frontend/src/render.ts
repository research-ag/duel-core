// Generic view layer for any TwoPlayer-engine-backed game.
//
// `status(sid)` returns a per-caller View variant that already encodes
// which screen to show, so `renderView` is a straight switch on that tag
// — never reassemble UI policy from raw flags. Every phase except
// `inGame`/`debrief` is rendered entirely by this module; those two defer
// the board and action markup to a game-supplied `GamePlugin`:
//
//   {
//     seatLabel(seatTag) => string,                         // "White" / "Black"
//     renderBoard(gameState, mySeat, oppSeat, yourTurn?) => htmlString,
//     renderActions(gameState, mySeat) => htmlString,        // buttons; see actionAttr()
//   }
//
// `yourTurn` (only present in an #inGame render, undefined for a
// debrief's final-state one) is a convenience for a game that puts its
// own interaction directly on the board (clickable squares) instead of
// `renderActions`' own separate panel — see GamePlugin's own doc.
//
// Everything in this module is a pure function to an HTML string: no
// DOM, no network, no globals. That's what makes it testable outside a
// browser, and pluggable with any move/state shape a game defines.

import type {
  AwaitingRematchView,
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

/// Encodes an arbitrary move value into a `data-act` attribute the
/// framework's click delegation (see app.ts) knows how to decode back
/// into the exact value to submit — so a game's `Action` can be any
/// Candid shape, not just a bare nullary variant.
export function actionAttr(actionValue: unknown): string {
  return `data-act='${esc(JSON.stringify(actionValue))}'`;
}

/// Text for every engine-level `Err` variant. Games never need to add
/// cases here — these describe TwoPlayer's own rejections, never a
/// game's `illegalMove` reason (which the engine already returns as
/// free text from the game's own `validate`).
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

// ---------------------------------------------------------------------
// The lobby-of-tables screen (`Status.browsing` — nobody's created or
// joined a table yet). Two parts: a "create a table" form (seat +
// open/protected visibility) and the browsable list of tables — open
// AND protected alike, a protected row just flagged as such. Clicking an
// open seat on a protected row prompts for its access code (app.ts's
// `showCodePrompt`) before dispatching the same `joinTable` request an
// open row's seat button sends directly. See app.ts's click delegation
// for how each button's dataset is read back into a `createTable`/
// `joinTable` request.
// ---------------------------------------------------------------------

// Pure text formatter for a table row's waiting time — shared between the
// initial render here and app.ts's `makeTableWaitTicker`, which patches
// this same text in place once a second so it counts up between pushes
// instead of sitting frozen at whatever `waitingSecs` last read (see that
// function's own doc for why a bare push alone isn't enough).
export function waitingText(waitingSecs: bigint): string {
  return `waiting ${waitingSecs}s`;
}

/// Max length a player id shows at before this truncates it (with a
/// trailing ellipsis) — a session id is client-chosen and can be
/// arbitrarily long (a logged-in player's is a full principal, textually
/// much longer than an anonymous, hand-rolled one), and a table row has
/// no room to lay one out in full next to its own seat buttons.
export const PLAYER_ID_MAX_LEN = 16;

/// Truncates `id` to `PLAYER_ID_MAX_LEN` for inline display — `truncated`
/// tells the caller whether to also attach the untruncated id as a
/// tooltip (see `renderTableRow`'s own occupant markup): a short id that
/// already fits needs no `title` attribute repeating itself on hover.
export function truncatePlayerId(id: string): { text: string; truncated: boolean } {
  if (id.length <= PLAYER_ID_MAX_LEN) return { text: id, truncated: false };
  return { text: `${id.slice(0, PLAYER_ID_MAX_LEN)}…`, truncated: true };
}

/// A session id's stable per-PLAYER key — mirrors `Ws.playerKey` on the
/// backend exactly (`mo:duel-game-core/ws`): strips the reserved `ii:`/
/// `an:` prefix down to the bare principal text, so a caller's own
/// `session.sid` can be compared against a `LeaderboardEntry.player`
/// value (see `renderLeaderboard`'s own `yourSid` option, below). Any
/// other sid — most notably `cp:`, a canister-player session, never
/// something a browser tab's OWN session is — is returned unchanged.
export function playerKeyOf(sid: string): string {
  if (sid.startsWith("ii:")) return sid.slice(3);
  if (sid.startsWith("an:")) return sid.slice(3);
  return sid;
}

/// Whether a `LeaderboardEntry.player` names a canister-seated player, not
/// a human — see `mo:duel-game-core/canister_players`'s own
/// `sidForCanister`/`CP_SID_PREFIX` doc. A human's own key never carries
/// any prefix at all (`Ws.playerKey`/`playerKeyOf` above already strip
/// `ii:`/`an:` before a score is ever stored), so a `cp:` prefix
/// surviving into a stored entry — added deliberately by whichever
/// `Host.mo` wires canister players, to key a bot's rating/best-lap by
/// its own stable principal rather than one of its many per-table sids —
/// is the only marker a leaderboard row can still carry.
const CANISTER_PLAYER_PREFIX = "cp:";
export function isCanisterPlayer(player: string): boolean {
  return player.startsWith(CANISTER_PLAYER_PREFIX);
}

/// `player` with the `cp:` marker (see `isCanisterPlayer`, above)
/// stripped for display, same as a human's own key already has no
/// prefix to strip. Returns `player` unchanged for anyone else.
export function displayPlayerId(player: string): string {
  return isCanisterPlayer(player) ? player.slice(CANISTER_PLAYER_PREFIX.length) : player;
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
    // `data-protected` (bare — read via `"protected" in dataset`, same
    // idiom as `data-leave`/`data-reset`/...) marks an OPEN seat on a
    // protected table so app.ts's click delegation knows to prompt for
    // the access code before dispatching the same `joinTable` request an
    // open table's seat sends directly — irrelevant, but harmless, on a
    // disabled (already-taken) seat.
    return `
    <button class="seat" data-join-table-id="${r.id}" data-join-table="${seat}"${r.protected ? " data-protected" : ""} ${open ? "" : "disabled"}>
      <span class="seat-label">${esc(plugin.seatLabel(seat))}</span>
      ${occupantHtml}
    </button>`;
  };
  return `
    <div class="table-row">
      <span class="table-id">Table #${r.id}${r.protected ? ` <span class="protected-badge" title="Requires an access code">🔒 Protected</span>` : ""}</span>
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
  return `
    <h2>Duel lobby</h2>

    <section class="create-table">
      <h3>Start a new table</h3>
      <label><input type="radio" name="table-visibility" value="open" checked /> Open — anyone can join</label>
      <label><input type="radio" name="table-visibility" value="code" /> Protected — share a code with a friend</label>
      <input type="text" id="create-code" class="table-code-input" placeholder="access code" hidden />
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

// Once a staged (not-yet-started) seat is close to going idle, warn its own
// occupant — status()'s own #stagingYou branch never checks expiry (see
// lib.mo's comment on it), so without this a player sees a calm "Waiting
// for an opponent" right up until another tab's `join` legitimately (and
// silently, from this player's point of view) reclaims the seat — the
// engine's documented "no ghost lobbies" idle takeover, working exactly as
// designed, just with no warning attached. Quiet below the threshold so a
// normal, short wait doesn't carry a running countdown the whole time.
//
// Rendered unconditionally (never omitted, just `hidden`) for the same
// reason `renderInGame`'s idle-reset warning is: `secondsUntilReclaimable`
// is only ever as fresh as the last push (no push repeats on a bare tick
// of the clock — see `ws.mo`'s `sweepAndPush` doc), so `app.ts`'s
// `makeCountdownTicker` needs a stable element to find by id and patch in
// place every second between pushes — an element that only exists once
// the threshold is already crossed could never be found BEFORE that, and
// the countdown would sit frozen exactly like the 007 defect report's
// finding 05 found it (byte-identical from 5s through 59s, then straight
// to "seat gone" with no warning ever having appeared).
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
  // `"code" in v.visibility` — the only other arm is `{ open: null }` —
  // names this table's own access code, echoed back ONLY on the
  // occupant's own view of their OWN table (see types.ts's own doc on
  // `StagingYouView.visibility`). A protected table's whole feature is
  // sharing table # (already shown above by the "Table #N" badge
  // renderStatus prefixes every atTable screen with) and this code with
  // a friend — without surfacing it here, that was never possible at
  // all, and the generic "open this page in another tab" copy below is
  // actively wrong for a protected table: no OTHER tab can take this
  // seat without the code too.
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

// The Forfeit button carries `data-confirm="..."` — app.ts's click
// delegation shows a confirmation modal before dispatching any button
// with that attribute, so a mid-game misclick can't hand the round to
// the opponent unintentionally. The other `data-leave` buttons — staging
// (renderStagingYou), debrief (renderDebrief), and the Decline button
// above (renderAwaitingRematch) — deliberately don't carry it: leaving
// before a game starts, after it's already over, or declining an invite
// nobody's forced to accept, isn't destructive the same way.
// A live game's own idle-reset countdown warns IN PLACE, the same idea as
// `renderStagingYou`'s reclaim warning above but for a seated,
// in-progress round instead of an unfilled seat — `#inGame` carries the
// raw countdown fresh as of this push (`secondsUntilIdleReset`) plus the
// table's own configured timeout (`idleTimeoutSecs`, constant for the
// table's life), so the threshold scales with whatever timeout THIS
// table actually runs instead of a hardcoded guess (the reclaim warning
// above uses a flat `RECLAIM_WARNING_SECS` instead — nothing forces the
// two to share a policy, they just happen to warn about the same
// underlying idle-takeover mechanism from two different phases).
// `app.ts`'s shared `makeCountdownTicker` re-runs `idleWarningText`/
// `idleWarningThreshold` itself every second, off its own wall clock, to
// patch #DUEL_IDLE_WARNING_ID's text/visibility in place between pushes —
// see its own doc for why a push alone would otherwise leave this frozen.
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

// The claim clock — `secondsUntilClaimable`/`claimWinAvailable` describe
// the SAME table-wide clock (time since whichever move went in first this
// round) from either seat's own point of view, so which of two roles a
// player is in decides both the wording and whether a button belongs
// next to it:
//   - "waiting": YOUR OWN move is locked in and the opponent's is
//     overdue — offers to claim the win outright instead of waiting them
//     out.
//   - "atRisk": the OPPONENT's move is locked in and yours is overdue —
//     the mirror image, so the still-deciding player can see they're
//     about to lose by forfeit if they don't act, not just find out after
//     the fact. No button here; only the "waiting" opponent can actually
//     claim.
// These, and the idle-reset warning above (for a player still deciding
// with NEITHER move overdue in the claim sense — just running long), are
// mutually exclusive by construction (`youSubmitted`/`oppSubmitted` can't
// both true — the round would already have resolved) so at most one of
// the three ever shows at once.
export const DUEL_CLAIM_WARNING_ID = "duel-claim-warning";
export const DUEL_CLAIM_BUTTON_ID = "duel-claim-button";

// Quiet below the threshold, same idea as `renderStagingYou`'s reclaim
// warning — a normal short wait for the opponent's move doesn't carry a
// running countdown the whole time, only once it's actually close.
export function claimWarningThreshold(claimTimeoutSecs: bigint): bigint {
  const half = claimTimeoutSecs / 2n;
  return half < 15n ? half : 15n;
}

export function claimWarningText(secondsUntilClaimable: bigint): string {
  const when = secondsUntilClaimable <= 0n ? "now" : `in ${secondsUntilClaimable}s`;
  return `Your opponent hasn't moved. You'll be able to claim the win ${when} if they still haven't.`;
}

// The "atRisk" counterpart to `claimWarningText` above — same clock, the
// OTHER player's own point of view. Deliberately has no "any moment now"-
// style button to pair with it: only the WAITING player (the one who
// actually submitted) can claim; this player's only way out is to submit
// their own move before that happens.
export function atRiskWarningText(secondsUntilClaimable: bigint): string {
  const when = secondsUntilClaimable <= 0n ? "now" : `in ${secondsUntilClaimable}s`;
  return `You haven't moved yet. Your opponent can claim the win ${when} if you don't.`;
}

function renderInGame<S>(v: InGameView<S>, plugin: GamePlugin<S>): string {
  const mySeat = tag(v.seat) as SeatTag;
  const oppSeat: SeatTag = mySeat === "p1" ? "p2" : "p1";
  const alternating = "alternating" in v.mode;
  // A player who already locked in this round can't do anything more about
  // the idle clock — "Still thinking?" doesn't even apply to them, and the
  // one actually holding up the round (the opponent) is the one who needs
  // the nudge, not them. `app.ts`'s `syncIdleTick` mirrors this same
  // youSubmitted check so the local per-second tick doesn't un-hide it
  // between pushes either. In `#alternating` mode this is exactly "it's
  // not your turn" — see `InGameView.mode`'s own doc for why the same
  // booleans mean the same thing (who's WAITING) in both modes.
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
            // "waiting": once claimable, the countdown text steps aside
            // for the button below it — showing both would be redundant.
            // "atRisk" has no button to step aside for, so the text just
            // keeps reading "now" for as long as the opponent hasn't
            // actually clicked it (or the player finally moves).
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

/// View -> HTML. One branch per per-table engine phase; `inGame`/
/// `debrief` delegate the board/action markup to `plugin`. Always
/// reached through `renderStatus` below via a `Status.atTable` — never
/// called directly on a `browsing` status, which has no single table's
/// `View` to speak of.
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

/// Status -> HTML, the top-level entry point `app.ts` renders every
/// screen through. `browsing` is the multi-table lobby (`renderBrowsing`
/// above); `atTable` prefixes a small "Table #N" badge and delegates the
/// rest to `renderView`.
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

/// Renders a ranked `LeaderboardEntry[]` (as returned by a host's own
/// `get_leaderboard` query — see `../../backend/README.md`'s
/// "Leaderboard" section) into HTML. Entirely game-optional and never
/// wired into `renderView`/`renderStatus` above: unlike the lobby/
/// staging/debrief chrome, a leaderboard has no fixed place in every
/// game's own layout (007/checkers might put it in a persistent tab;
/// racing might put it beside its own `Add Bot` panel — see
/// `examples/racing/CLAUDE.md`), so a game calls this directly, wherever
/// it mounts its own panel. `entries` is assumed already in rank order
/// (`Leaderboard.top`'s own contract, highest score first); this
/// function does no sorting of its own. `plugin.formatScore` renders
/// each entry's own `score` — see that field's own doc for why a plain
/// integer is the correct default for an ELO-scored game. `opts.yourSid`
/// — pass the caller's own `session.sid` — picks out that player's own
/// row (a "You" badge, plus a `.you` class on the row for a game's own
/// stylesheet to highlight) via `playerKeyOf`, above; omit it (or leave
/// the caller off the ranked slice entirely) and no row is marked. A
/// canister-seated player's own row (`isCanisterPlayer`, above) gets a
/// 🤖 icon and its `cp:` marker stripped for display, the same as a
/// human's own key already shows with no prefix at all.
export function renderLeaderboard(
  entries: LeaderboardEntry[],
  plugin: GamePlugin,
  opts?: { yourSid?: string },
): string {
  if (entries.length === 0) {
    return `<p class="muted">No games finished yet — the leaderboard is empty.</p>`;
  }
  const you = opts?.yourSid !== undefined ? playerKeyOf(opts.yourSid) : undefined;
  const format = plugin.formatScore ?? ((score: bigint) => score.toString());
  const rows = entries
    .map((e, i) => {
      // Unlike `renderTableRow`'s own `truncatePlayerId` (a fixed
      // 16-char cutoff, sized for a cramped table row next to seat
      // buttons), a leaderboard row has real width to spare — the full
      // id is rendered here and left to `.leaderboard-player`'s own CSS
      // (`overflow: hidden; text-overflow: ellipsis`) to clip responsively
      // against whatever width it actually gets, showing far more of the
      // principal on a wide screen than a fixed char count ever would.
      // `title` is unconditional here (unlike `renderTableRow`'s, which
      // only adds one once ITS OWN fixed-length truncation actually
      // fired) since there's no way to know in advance whether THIS id
      // will get CSS-clipped at the viewer's own width.
      const isYou = you !== undefined && e.player === you;
      const isBot = isCanisterPlayer(e.player);
      const botIcon = isBot ? `<span class="leaderboard-bot-icon" title="Canister player">🤖</span>` : "";
      return `
    <div class="leaderboard-row${isYou ? " you" : ""}">
      <span class="leaderboard-rank">${i + 1}</span>
      <span class="leaderboard-player" title="${esc(e.player)}">${botIcon}${esc(displayPlayerId(e.player))}</span>
      ${isYou ? `<span class="leaderboard-you-badge">You</span>` : ""}
      <span class="leaderboard-score">${esc(format(e.score))}</span>
    </div>`;
    })
    .join("");
  return `<div class="leaderboard">${rows}</div>`;
}
