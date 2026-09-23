import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionAttr,
  DUEL_IDLE_WARNING_ID,
  DUEL_RECLAIM_WARNING_ID,
  DUEL_CLAIM_WARNING_ID,
  DUEL_CLAIM_BUTTON_ID,
  claimWarningThreshold,
  displayPlayerId,
  errText,
  esc,
  isCanisterPlayer,
  PLAYER_ID_MAX_LEN,
  playerKeyOf,
  renderLeaderboard,
  renderStatus,
  renderView,
  tag,
  truncatePlayerId,
  val,
} from "../src/render.js";
import type { GamePlugin, LeaderboardEntry, Status, TableSummary, View } from "../src/types.js";

const plugin: GamePlugin<{ turn: string }> = {
  idlTypes: () => {
    throw new Error("not used in these tests");
  },
  seatLabel: (seat) => (seat === "p1" ? "White" : "Black"),
  renderBoard: (game) => `<div class="board-state">${esc(JSON.stringify(game))}</div>`,
  renderActions: () => `<button ${actionAttr({ pass: null })}>Pass</button>`,
};

/// Whether the claim-win button's own `<button id="duel-claim-button" ...>`
/// tag carries `hidden` — attribute order inside that tag isn't fixed
/// (`id` always comes first, `hidden` only when present, appended last),
/// so a fixed-adjacency string match on the raw HTML would be brittle;
/// this pulls out the button's own opening tag first and checks it there.
function claimButtonHidden(html: string): boolean {
  const tagMatch = new RegExp(`<button id="${DUEL_CLAIM_BUTTON_ID}"[^>]*>`).exec(html);
  return tagMatch !== null && /\bhidden\b/.test(tagMatch[0]);
}

test("tag/val unwrap a single-key variant object", () => {
  assert.equal(tag({ p1: null }), "p1");
  assert.equal(val({ p1: null }), null);
  assert.equal(tag({ illegalMove: "no" }), "illegalMove");
  assert.equal(val({ illegalMove: "no" }), "no");
});

test("esc escapes the five HTML metacharacters", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("esc stringifies non-string input", () => {
  assert.equal(esc(5n), "5");
  assert.equal(esc(null), "null");
});

test("actionAttr round-trips through JSON for the click delegation to decode", () => {
  const attr = actionAttr({ shoot: { power: 3 } });
  const m = /data-act='([^']*)'/.exec(attr);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m![1].replace(/&#39;/g, "'").replace(/&quot;/g, '"')), {
    shoot: { power: 3 },
  });
});

test("errText: fixed-text variants", () => {
  assert.equal(errText({ seatTaken: null }), "That seat is already taken.");
  assert.equal(errText({ notSeated: null }), "You are not seated in this game.");
  assert.equal(errText({ alreadySubmitted: null }), "You have already moved this round.");
  assert.equal(errText({ notYourTurn: null }), "It's not your turn.");
  assert.equal(errText({ unauthorized: null }), "This session belongs to a different signed-in identity.");
});

test("errText: variants carrying their own message", () => {
  assert.equal(errText({ illegalMove: "not your turn" }), "not your turn");
  assert.equal(errText({ wrongPhase: "game is over" }), "game is over");
});

test("errText: variants carrying a countdown", () => {
  assert.equal(
    errText({ reserved: { secondsLeft: 12n } }),
    "That seat is held for a rematch — 12s left.",
  );
  assert.equal(
    errText({ notIdle: { secondsLeft: 7n } }),
    "The board is in use — 7s until it can be taken over.",
  );
  assert.equal(
    errText({ notOverdue: { secondsLeft: 4n } }),
    "Your opponent hasn't gone quiet long enough yet — 4s left before you can claim the win.",
  );
});

test("renderView: lobby shows both seats, open vs taken", () => {
  const html = renderView<{ turn: string }>(
    { lobby: { p1Open: true, p2Open: false, resetAvailable: false } },
    plugin,
  );
  assert.match(html, /Choose your seat/);
  assert.match(html, /data-join-table="p1"/);
  assert.doesNotMatch(html, /data-join-table="p1"[^>]*disabled/);
  assert.match(html, /data-join-table="p2"[^>]*disabled/);
  assert.doesNotMatch(html, /data-reset/);
});

test("renderView: lobby shows the reset button only when resetAvailable", () => {
  const html = renderView<{ turn: string }>(
    { lobby: { p1Open: true, p2Open: true, resetAvailable: true } },
    plugin,
  );
  assert.match(html, /data-reset/);
});

test("truncatePlayerId: leaves a short id untouched and flags nothing to truncate", () => {
  const short = "abc123";
  assert.deepEqual(truncatePlayerId(short), { text: short, truncated: false });
  // Exactly at the limit is still untouched — only strictly LONGER ids
  // get truncated.
  const exact = "a".repeat(PLAYER_ID_MAX_LEN);
  assert.deepEqual(truncatePlayerId(exact), { text: exact, truncated: false });
});

test("truncatePlayerId: cuts a long id to PLAYER_ID_MAX_LEN plus an ellipsis, and flags it", () => {
  const long = "ii:abcdefghijklmnopqrstuvwxyz";
  const { text, truncated } = truncatePlayerId(long);
  assert.equal(truncated, true);
  assert.equal(text, `${long.slice(0, PLAYER_ID_MAX_LEN)}…`);
});

function browsingStatus(tables: TableSummary[]): Status<{ turn: string }> {
  return { browsing: { tables } };
}

test("renderStatus: browsing lists a protected table alongside open ones, flagged and never leaking its code", () => {
  const html = renderStatus(
    browsingStatus([
      { id: 1n, p1Open: false, p2Open: true, p1Session: ["alice"], p2Session: [], protected: false, waitingSecs: 2n },
      { id: 2n, p1Open: false, p2Open: true, p1Session: ["carol"], p2Session: [], protected: true, waitingSecs: 5n },
    ]),
    plugin,
  );
  assert.match(html, /Table #1/);
  assert.match(html, /Table #2/);
  // Only table 2 is flagged protected — table 1's own row carries no
  // badge at all.
  assert.doesNotMatch(html.split("Table #2")[0]!, /protected-badge/);
  assert.match(html, /protected-badge/);
  assert.match(html, /Protected/);
  // The old "Have a code?" mini-form is gone for good.
  assert.doesNotMatch(html, /Have a code/);
  assert.doesNotMatch(html, /joinbycode/);
});

test("renderStatus: browsing marks a protected row's open seat with data-protected, so app.js knows to prompt for the code; an open table's own seats never carry it", () => {
  const html = renderStatus(
    browsingStatus([
      { id: 2n, p1Open: false, p2Open: true, p1Session: ["carol"], p2Session: [], protected: true, waitingSecs: 0n },
      { id: 3n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n },
    ]),
    plugin,
  );
  assert.match(html, /data-join-table-id="2" data-join-table="p2" data-protected/);
  assert.doesNotMatch(html, /data-join-table-id="3"[^>]*data-protected/);
});

test("renderStatus: browsing shows a taken seat's occupant id, truncated with a tooltip past PLAYER_ID_MAX_LEN", () => {
  const longId = "ii:abcdefghijklmnopqrstuvwxyz";
  const html = renderStatus(
    browsingStatus([
      { id: 5n, p1Open: false, p2Open: true, p1Session: [longId], p2Session: [], protected: false, waitingSecs: 0n },
    ]),
    plugin,
  );
  const { text } = truncatePlayerId(longId);
  assert.match(html, new RegExp(`seat-occupant" title="${longId}">${text}`));
});

test("renderStatus: browsing shows a short occupant id verbatim, with no tooltip", () => {
  const html = renderStatus(
    browsingStatus([
      { id: 6n, p1Open: false, p2Open: true, p1Session: ["bob"], p2Session: [], protected: false, waitingSecs: 0n },
    ]),
    plugin,
  );
  assert.match(html, /<span class="seat-occupant">bob<\/span>/);
});

test("renderView: busy shows the takeover countdown", () => {
  const html = renderView<{ turn: string }>({ busy: { secondsUntilTakeover: 42n } }, plugin);
  assert.match(html, /42s until it can be taken over/);
});

test("renderView: stagingYou names the held seat and offers Leave", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p2: null },
        reservedForPartner: false,
        secondsUntilReclaimable: 999n,
        gen: 1n,
        visibility: { open: null },
      },
    },
    plugin,
  );
  assert.match(html, /Black/);
  assert.match(html, /data-leave/);
  assert.match(html, /Open this page in another tab/);
  // Above the 15s warning threshold — the countdown element is rendered
  // (so app.ts's ticker can find and patch it in place — see its own
  // doc), but stays hidden.
  assert.match(html, new RegExp(`id="${DUEL_RECLAIM_WARNING_ID}" hidden`));
});

test("renderView: stagingYou on a Protected table shows the access code, not the 'open this page in another tab' copy (regression: the code was never shown, and that copy is actively wrong for a protected table)", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p1: null },
        reservedForPartner: false,
        secondsUntilReclaimable: 999n,
        gen: 1n,
        visibility: { code: "TOP-SECRET" },
      },
    },
    plugin,
  );
  assert.match(html, /Protected/);
  assert.match(html, /TOP-SECRET/);
  assert.doesNotMatch(html, /Open this page in another tab/);
});

test("renderView: stagingYou warns once reclaim is imminent", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p1: null },
        reservedForPartner: true,
        secondsUntilReclaimable: 5n,
        gen: 1n,
        visibility: { open: null },
      },
    },
    plugin,
  );
  assert.match(html, /Still there\?/);
  assert.match(html, /in 5s/);
  assert.doesNotMatch(html, new RegExp(`id="${DUEL_RECLAIM_WARNING_ID}" hidden`));
});

test("renderView: stagingYou reclaim warning at exactly 0s says 'any moment now'", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p1: null },
        reservedForPartner: true,
        secondsUntilReclaimable: 0n,
        gen: 1n,
        visibility: { open: null },
      },
    },
    plugin,
  );
  assert.match(html, /any moment now/);
});

test("renderView: awaitingRematch names the open seat and offers accept + decline", () => {
  const html = renderView<{ turn: string }>({ awaitingRematch: { openSeat: { p1: null }, gen: 1n } }, plugin);
  assert.match(html, /White/);
  assert.match(html, /data-rematch/);
  assert.match(html, /data-leave/); // Decline — see app.ts's doLeave/genOf
});

test("renderView: inGame shows the turn counter (1-indexed) and delegates board/actions", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /Round <strong>1<\/strong>/);
  assert.match(html, /○ Opponent is deciding/);
  assert.match(html, /board-state/);
  assert.match(html, /Pass/);
  assert.match(html, /data-confirm="Forfeit/);
});

test("renderView: inGame uses turn-accurate copy for an #alternating table", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { alternating: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /Move <strong>1<\/strong>/);
  assert.doesNotMatch(html, /Round </);
  assert.match(html, /◉ Your turn/);
  assert.doesNotMatch(html, /Opponent has locked in/);
  assert.match(html, /Pass/); // it's this seat's turn — actions are shown
});

test("renderView: inGame shows the waiting-for-turn copy once it's the opponent's turn, #alternating", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { alternating: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 1n,
        youSubmitted: true,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /○ Opponent's turn/);
  assert.match(html, /Waiting for your opponent's turn…/);
  assert.doesNotMatch(html, /Pass/); // not this seat's turn — actions are hidden
});

test("renderView: inGame hides actions and shows the waiting note once submitted", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 2n,
        youSubmitted: true,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /◉ Opponent has locked in/);
  assert.match(html, /Move locked in/);
  assert.doesNotMatch(html, /Pass/);
  // Both submitted (a synthetic, never-observed engine state — the round
  // would already have resolved) — the claim-win UI is for the WAITING
  // player specifically, so it must not appear here either.
  assert.doesNotMatch(html, /data-claim-win/);
});

test("renderView: inGame shows the idle-reset warning once within threshold, for the player still deciding", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 10n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /Still thinking\? This game will be interrupted in 10s/);
  assert.doesNotMatch(html, new RegExp(`id="${DUEL_IDLE_WARNING_ID}" hidden`));
});

test("renderView: inGame hides the idle-reset warning for a player who already locked in, even within threshold", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: true,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 5n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 15n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, new RegExp(`id="${DUEL_IDLE_WARNING_ID}" hidden`));
});

test("claimWarningThreshold: min(15s, claimTimeoutSecs / 2)", () => {
  assert.equal(claimWarningThreshold(20n), 10n); // 20/2=10, below the 15s cap
  assert.equal(claimWarningThreshold(60n), 15n); // 60/2=30, clamped to 15s
  assert.equal(claimWarningThreshold(4n), 2n);
});

test("renderView: inGame keeps the claim-win countdown quiet until within its own threshold (min(15s, claimTimeoutSecs/2))", () => {
  // claimTimeoutSecs = 20 → threshold = min(15, 10) = 10. 15s left is
  // still well outside that — the countdown must stay hidden (regression:
  // it used to show, and tick down, for the ENTIRE claim window).
  const farOut = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: true,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 15n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(farOut, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));
  assert.ok(claimButtonHidden(farOut));

  // 8s left is within the same 10s threshold — now it shows, ticking.
  const withinThreshold = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: true,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 8n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(withinThreshold, /Your opponent hasn't moved\. You'll be able to claim the win in 8s/);
  assert.doesNotMatch(withinThreshold, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));
  // Still not claimable yet — the button itself stays hidden.
  assert.ok(claimButtonHidden(withinThreshold));
});

test("renderView: inGame offers the Claim the win button once the claim window has elapsed", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: true,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: true,
        secondsUntilClaimable: 0n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(html, /data-claim-win/);
  assert.ok(!claimButtonHidden(html));
  assert.match(html, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));
});

test("renderView: inGame warns the STILL-DECIDING player that their opponent could claim the win (the 'atRisk' mirror of the waiting player's own countdown) — no button of their own", () => {
  // Same clock, opposite seat: you haven't submitted, your opponent has.
  const withinThreshold = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false, // always false from THIS seat's own view — only the submitter can claim
        secondsUntilClaimable: 8n,
        claimTimeoutSecs: 20n, // threshold = min(15, 10) = 10 — 8s is inside it
      },
    },
    plugin,
  );
  assert.match(withinThreshold, /You haven't moved yet\. Your opponent can claim the win in 8s if you don't\./);
  assert.doesNotMatch(withinThreshold, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));
  assert.doesNotMatch(withinThreshold, /data-claim-win/); // never a button for this seat

  // Far outside the threshold — stays quiet, same as the waiting player's
  // own countdown does.
  const farOut = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 15n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(farOut, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));

  // Once the window has fully elapsed, the warning — unlike the waiting
  // player's own, which steps aside for the Claim button — keeps reading
  // "now" instead of disappearing: this player has no button to hand off
  // to, only their own next move (or the opponent's eventual click) ends
  // the wait.
  const overdue = renderView<{ turn: string }>(
    {
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 40n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 0n,
        claimTimeoutSecs: 20n,
      },
    },
    plugin,
  );
  assert.match(overdue, /Your opponent can claim the win now if you don't\./);
  assert.doesNotMatch(overdue, new RegExp(`id="${DUEL_CLAIM_WARNING_ID}" hidden`));
  assert.doesNotMatch(overdue, /data-claim-win/);
});

test("renderView: debrief — win/lose/draw wording from the acting seat's own point of view", () => {
  const base = {
    seat: { p1: null } as const,
    turns: 3n,
    finalGame: { turn: "x" },
    gen: 1n,
  };
  const win = renderView<{ turn: string }>(
    { debrief: { ...base, end: { finished: { p1Wins: null } } } },
    plugin,
  );
  assert.match(win, /You win/);

  const lose = renderView<{ turn: string }>(
    { debrief: { ...base, end: { finished: { p2Wins: null } } } },
    plugin,
  );
  assert.match(lose, /You lose/);

  const draw = renderView<{ turn: string }>(
    { debrief: { ...base, end: { finished: { draw: null } } } },
    plugin,
  );
  assert.match(draw, /It's a draw/);
});

test("renderView: debrief — aborted wording distinguishes who walked away", () => {
  const youLeft = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 1n,
        finalGame: { turn: "x" },
        end: { aborted: { p1: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(youLeft, /You walked away/);

  const oppLeft = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 1n,
        finalGame: { turn: "x" },
        end: { aborted: { p2: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(oppLeft, /Your opponent walked away/);
});

test("renderView: debrief — claimed wording distinguishes who claimed the overdue win", () => {
  const youClaimed = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 1n,
        finalGame: { turn: "x" },
        end: { claimed: { p1: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(youClaimed, /You win — your opponent didn't move in time/);

  const oppClaimed = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 1n,
        finalGame: { turn: "x" },
        end: { claimed: { p2: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(oppClaimed, /You lose — you didn't move in time/);
});

test("renderView: debrief pluralizes 'round(s)' correctly", () => {
  const one = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 1n,
        finalGame: { turn: "x" },
        end: { finished: { draw: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(one, /1 round\./);

  const many = renderView<{ turn: string }>(
    {
      debrief: {
        seat: { p1: null },
        turns: 3n,
        finalGame: { turn: "x" },
        end: { finished: { draw: null } },
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(many, /3 rounds\./);
});

test("renderView: endedByOther offers an ack button", () => {
  const html = renderView<{ turn: string }>({ endedByOther: null }, plugin);
  assert.match(html, /Your game was ended/);
  assert.match(html, /data-ack/);
});

test("renderView: unknown tag falls back to an escaped error line, never throws", () => {
  const html = renderView<{ turn: string }>({ mystery: null } as unknown as View<{ turn: string }>, plugin);
  assert.match(html, /Unknown view: mystery/);
});

test("renderLeaderboard: an empty board says so instead of an empty list", () => {
  const html = renderLeaderboard([], plugin);
  assert.match(html, /No games finished yet/);
});

test("renderLeaderboard: ranks entries in the order given, 1-indexed, with no plugin formatter the raw score shows as-is", () => {
  const entries: LeaderboardEntry[] = [
    { player: "ii:alice", score: 1600n, updatedAt: 1n },
    { player: "ii:bob", score: 1400n, updatedAt: 2n },
  ];
  const html = renderLeaderboard(entries, plugin);
  const rowCount = (html.match(/class="leaderboard-row"/g) ?? []).length;
  assert.equal(rowCount, 2);
  const aliceIdx = html.indexOf("alice");
  const bobIdx = html.indexOf("bob");
  assert.ok(aliceIdx >= 0 && bobIdx > aliceIdx, "alice (rank 1) must render before bob (rank 2)");
  assert.match(html, /1600/);
  assert.match(html, /1400/);
});

test("renderLeaderboard: renders the FULL player id (unlike renderTableRow's fixed-length truncation) and always attaches it as a title", () => {
  // A leaderboard row has real width to spare, unlike a cramped table
  // row next to seat buttons — truncation for display is CSS's job
  // (`.leaderboard-player`'s own `text-overflow: ellipsis`, clipped
  // responsively against whatever width it actually gets), not a fixed
  // char count baked into the HTML.
  const longId = "ii:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const html = renderLeaderboard([{ player: longId, score: 1200n, updatedAt: 0n }], plugin);
  assert.match(html, new RegExp(`>${esc(longId)}<`));
  assert.match(html, new RegExp(`title="${esc(longId)}"`));
});

test("renderLeaderboard: uses the plugin's own formatScore when supplied", () => {
  const racingPlugin: GamePlugin<{ turn: string }> = {
    ...plugin,
    formatScore: (score) => {
      const ms = 3_600_000n - score;
      const totalSeconds = Number(ms) / 1000;
      const m = Math.floor(totalSeconds / 60);
      const s = (totalSeconds % 60).toFixed(3).padStart(6, "0");
      return `${m}:${s}`;
    },
  };
  const html = renderLeaderboard([{ player: "ii:racer", score: 3_501_796n, updatedAt: 0n }], racingPlugin);
  assert.match(html, /1:38\.204/);
  assert.doesNotMatch(html, /3501796/);
});

test("playerKeyOf: strips the ii:/an: prefix, leaves anything else (e.g. cp:) unchanged", () => {
  assert.equal(playerKeyOf("ii:abc123"), "abc123");
  assert.equal(playerKeyOf("an:xyz789"), "xyz789");
  assert.equal(playerKeyOf("cp:abc123:7"), "cp:abc123:7");
});

test("renderLeaderboard: opts.yourSid marks the caller's own row with a You badge and the you class", () => {
  const entries: LeaderboardEntry[] = [
    { player: "abc123", score: 1600n, updatedAt: 1n },
    { player: "def456", score: 1400n, updatedAt: 2n },
  ];
  const html = renderLeaderboard(entries, plugin, { yourSid: "ii:def456" });
  assert.match(html, /leaderboard-row you/);
  assert.match(html, /leaderboard-you-badge">You</);
  // Only the matching row gets marked — exactly one "you" row, not both.
  assert.equal((html.match(/leaderboard-row you/g) ?? []).length, 1);
});

test("renderLeaderboard: no yourSid, or a caller not on the ranked slice, marks nothing", () => {
  const entries: LeaderboardEntry[] = [{ player: "abc123", score: 1600n, updatedAt: 1n }];
  const noOpt = renderLeaderboard(entries, plugin);
  assert.doesNotMatch(noOpt, /leaderboard-you-badge/);
  const notRanked = renderLeaderboard(entries, plugin, { yourSid: "ii:someone-else" });
  assert.doesNotMatch(notRanked, /leaderboard-you-badge/);
});

test("isCanisterPlayer/displayPlayerId: cp: is a canister player, stripped for display; anyone else is untouched", () => {
  assert.ok(isCanisterPlayer("cp:ietgl-ziaaa-aaaac-qhfga-cai"));
  assert.equal(displayPlayerId("cp:ietgl-ziaaa-aaaac-qhfga-cai"), "ietgl-ziaaa-aaaac-qhfga-cai");
  assert.ok(!isCanisterPlayer("ietgl-ziaaa-aaaac-qhfga-cai"));
  assert.equal(displayPlayerId("ietgl-ziaaa-aaaac-qhfga-cai"), "ietgl-ziaaa-aaaac-qhfga-cai");
});

test("renderLeaderboard: a canister-seated player's cp: marker is stripped from the visible text and a bot icon is shown", () => {
  const entries: LeaderboardEntry[] = [{ player: "cp:ietgl-ziaaa-aaaac-qhfga-cai", score: 1200n, updatedAt: 0n }];
  const html = renderLeaderboard(entries, plugin);
  assert.match(html, /leaderboard-bot-icon/);
  assert.match(html, /ietgl-ziaaa-aaaac-qhfga-cai/); // the bare principal is visible somewhere
  // "cp:" survives only inside a title="..." tooltip attribute — the
  // full raw key is still one hover away — never as visible text.
  assert.match(html, /title="cp:ietgl-ziaaa-aaaac-qhfga-cai"/);
  const withoutTitles = html.replace(/title="[^"]*"/g, "");
  assert.doesNotMatch(withoutTitles, /cp:/);
});

test("renderLeaderboard: a human player (no cp: prefix) gets no bot icon", () => {
  const entries: LeaderboardEntry[] = [{ player: "ietgl-ziaaa-aaaac-qhfga-cai", score: 1200n, updatedAt: 0n }];
  const html = renderLeaderboard(entries, plugin);
  assert.doesNotMatch(html, /leaderboard-bot-icon/);
});
