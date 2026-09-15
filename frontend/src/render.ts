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
//     renderBoard(gameState, mySeat, oppSeat) => htmlString,
//     renderActions(gameState, mySeat) => htmlString,        // buttons; see actionAttr()
//   }
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
// joined a table yet). Three parts: a "create a table" form (seat +
// open/protected visibility), the browsable list of open tables (each
// row its own per-seat join buttons), and a "join by code" mini-form for
// a table a friend shared out of band (never listed, since it's
// protected). See app.ts's click delegation for how each button's
// dataset is read back into a `createTable`/`joinTable` request.
// ---------------------------------------------------------------------

// Pure text formatter for a table row's waiting time — shared between the
// initial render here and app.ts's `makeTableWaitTicker`, which patches
// this same text in place once a second so it counts up between pushes
// instead of sitting frozen at whatever `waitingSecs` last read (see that
// function's own doc for why a bare push alone isn't enough).
export function waitingText(waitingSecs: bigint): string {
  return `waiting ${waitingSecs}s`;
}

function renderTableRow(r: TableSummary, plugin: GamePlugin): string {
  const seatBtn = (seat: SeatTag, open: boolean) => `
    <button class="seat" data-join-table-id="${r.id}" data-join-table="${seat}" ${open ? "" : "disabled"}>
      ${esc(plugin.seatLabel(seat))}
    </button>`;
  return `
    <div class="table-row">
      <span class="table-id">Table #${r.id}</span>
      <span class="muted" data-wait-base="${r.waitingSecs}">${waitingText(r.waitingSecs)}</span>
      <div class="table-row-seats">
        ${seatBtn("p1", r.p1Open)}
        ${seatBtn("p2", r.p2Open)}
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
      <h3>Open tables</h3>
      ${
        v.tables.length === 0
          ? `<p class="muted">No open tables right now — start one above.</p>`
          : v.tables.map((r) => renderTableRow(r, plugin)).join("")
      }
    </section>

    <section class="join-by-code">
      <h3>Have a code?</h3>
      <input type="number" id="joinbycode-id" placeholder="table #" min="0" step="1" />
      <input type="text" id="joinbycode-code" placeholder="access code" />
      <div class="seats">
        <button class="seat ghost" data-join-table-by-code="p1">${esc(plugin.seatLabel("p1"))}</button>
        <button class="seat ghost" data-join-table-by-code="p2">${esc(plugin.seatLabel("p2"))}</button>
      </div>
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
      <span>Round <strong>${v.turn + 1n}</strong></span>
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
    <div class="board">${plugin.renderBoard(v.game, mySeat, oppSeat)}</div>
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
