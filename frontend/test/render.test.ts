import { test } from "node:test";
import assert from "node:assert/strict";
import { actionAttr, errText, esc, renderView, tag, val } from "../src/render.js";
import type { GamePlugin, View } from "../src/types.js";

const plugin: GamePlugin<{ turn: string }> = {
  idlTypes: () => {
    throw new Error("not used in these tests");
  },
  seatLabel: (seat) => (seat === "p1" ? "White" : "Black"),
  renderBoard: (game) => `<div class="board-state">${esc(JSON.stringify(game))}</div>`,
  renderActions: () => `<button ${actionAttr({ pass: null })}>Pass</button>`,
};

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
});

test("renderView: lobby shows both seats, open vs taken", () => {
  const html = renderView<{ turn: string }>(
    { lobby: { p1Open: true, p2Open: false, resetAvailable: false } },
    plugin,
  );
  assert.match(html, /Choose your seat/);
  assert.match(html, /data-join="p1"/);
  assert.doesNotMatch(html, /data-join="p1"[^>]*disabled/);
  assert.match(html, /data-join="p2"[^>]*disabled/);
  assert.doesNotMatch(html, /data-reset/);
});

test("renderView: lobby shows the reset button only when resetAvailable", () => {
  const html = renderView<{ turn: string }>(
    { lobby: { p1Open: true, p2Open: true, resetAvailable: true } },
    plugin,
  );
  assert.match(html, /data-reset/);
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
      },
    },
    plugin,
  );
  assert.match(html, /Black/);
  assert.match(html, /data-leave/);
  // Above the 15s warning threshold — no countdown shown.
  assert.doesNotMatch(html, /Still there\?/);
});

test("renderView: stagingYou warns once reclaim is imminent", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p1: null },
        reservedForPartner: true,
        secondsUntilReclaimable: 5n,
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(html, /Still there\?/);
  assert.match(html, /in 5s/);
});

test("renderView: stagingYou reclaim warning at exactly 0s says 'any moment now'", () => {
  const html = renderView<{ turn: string }>(
    {
      stagingYou: {
        seat: { p1: null },
        reservedForPartner: true,
        secondsUntilReclaimable: 0n,
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(html, /any moment now/);
});

test("renderView: awaitingRematch names the open seat", () => {
  const html = renderView<{ turn: string }>({ awaitingRematch: { openSeat: { p1: null } } }, plugin);
  assert.match(html, /White/);
  assert.match(html, /data-rematch/);
});

test("renderView: inGame shows the turn counter (1-indexed) and delegates board/actions", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        seat: { p1: null },
        game: { turn: "x" },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: false,
        gen: 1n,
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

test("renderView: inGame hides actions and shows the waiting note once submitted", () => {
  const html = renderView<{ turn: string }>(
    {
      inGame: {
        seat: { p1: null },
        game: { turn: "x" },
        turn: 2n,
        youSubmitted: true,
        oppSubmitted: true,
        gen: 1n,
      },
    },
    plugin,
  );
  assert.match(html, /◉ Opponent has locked in/);
  assert.match(html, /Move locked in/);
  assert.doesNotMatch(html, /Pass/);
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
