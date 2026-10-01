import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeElement, makeFakeDocument, makeButton } from "./support/fake-dom.js";
import type { DuelWs, GamePlugin, Status, TableSummary, WsPayload, WsRequest } from "../src/types.js";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

interface PendingRequest {
  sid: string;
  req: WsRequest;
  resolve: (p: WsPayload) => void;
  reject: (e: Error) => void;
}

class FakeWs implements DuelWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: WsPayload }) => void) | null = null;
  onerror: ((ev: { error?: Error }) => void) | null = null;
  onclose: (() => void) | null = null;
  onconnecting: (() => void) | null = null;
  sent: Array<{ sid: string; req: WsRequest }> = [];
  requests: PendingRequest[] = [];
  request?: (sid: string, req: WsRequest) => Promise<WsPayload>;

  constructor(withRequest = true) {
    if (withRequest) {
      this.request = (sid, req) =>
        new Promise<WsPayload>((resolve, reject) => {
          this.requests.push({ sid, req, resolve, reject });
        });
    }
  }

  send(msg: { req: { sid: string; req: WsRequest } }): void {
    this.sent.push(msg.req);
  }
}

const plugin: GamePlugin<{ n: number }> = {
  idlTypes: () => {
    throw new Error("not used");
  },
  seatLabel: (seat) => (seat === "p1" ? "White" : "Black"),
  renderBoard: (game) => `<div class="board">n=${game.n}</div>`,
  renderActions: () => `<button data-act='{"pass":null}'>Pass</button>`,
};

/// Test-fixture helpers: every pushed/resolved `view` is now a `Status`,
/// not a bare per-table `View` — see types.ts's own doc. `browsing()`
/// defaults to an empty table list (most tests don't care what's
/// listed); `atTable()` wraps a per-table view under a fixed table id.
function browsing(tables: TableSummary[] = []): Status {
  return { browsing: { tables } };
}
function atTable(view: unknown, id = 1n): Status {
  return { atTable: { id, view } } as Status;
}

function setup(opts: { withRequest?: boolean } = {}) {
  const els = {
    sid: new FakeElement(),
    "new-sid": new FakeElement(),
    "duel-auth-btn": new FakeElement(),
    error: new FakeElement(),
    screen: new FakeElement(),
  };
  const doc = makeFakeDocument(els as unknown as Record<string, FakeElement>);
  (globalThis as unknown as { document: typeof doc }).document = doc;
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = new FakeStorage();
  (globalThis as unknown as { location: { search: string } }).location = { search: "" };

  const ws = new FakeWs(opts.withRequest ?? true);
  return { els, doc, ws };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { location?: unknown }).location;
});

function click(screen: FakeElement, button: FakeElement): void {
  screen.dispatch("click", { target: button });
}

// ── `session` (a resolveIdentity()/resolveAnonymousIdentity() result ───────
interface FakeSession {
  sid: string;
  isLoggedIn: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  regenerate: () => Promise<void>;
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    sid: "ii:abc",
    isLoggedIn: true,
    login: async () => {},
    logout: async () => {},
    regenerate: async () => {},
    ...overrides,
  };
}

// The plain, anonymous-by-default fixture most tests reach for: `new-sid`
// enabled (unless seated), no login/logout wired — matches this
// package's own default (no Internet Identity login step).
const defaultSession = fakeSession({ isLoggedIn: false });

test("start(): throws without plugin, ws, or session", async () => {
  const { start } = await import("../src/app.js");
  setup();
  assert.throws(() => start({ plugin: undefined as never, ws: new FakeWs(), session: defaultSession }), /`plugin` is required/);
  assert.throws(() => start({ plugin, ws: undefined as never, session: defaultSession }), /`ws` is required/);
  assert.throws(() => start({ plugin, ws: new FakeWs(), session: undefined as never }), /`session` is required/);
});

test("start(): throws a clear error when the screen element is missing", async () => {
  const { start } = await import("../src/app.js");
  const doc = makeFakeDocument({}); // no "screen" element registered
  (globalThis as unknown as { document: typeof doc }).document = doc;
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = new FakeStorage();
  (globalThis as unknown as { location: { search: string } }).location = { search: "" };
  assert.throws(() => start({ plugin, ws: new FakeWs(), session: defaultSession }), /no element with id "screen"/);
});

test("start(): shows a connecting placeholder and sends #status right away, not on ws.onopen", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });
  assert.match(els.screen.innerHTML, /Connecting/);
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.sent[0]!.req, { status: null });

  ws.onopen!();
  assert.equal(ws.sent.length, 1, "the first open must not ask again");
});

test("onmessage: a pushed status renders via the plugin", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: atTable({
        inGame: {
          mode: { simultaneous: null },
          seat: { p1: null },
          game: { n: 7 },
          turn: 0n,
          youSubmitted: false,
          oppSubmitted: false,
          gen: 1n,
          secondsUntilIdleReset: 60n,
          idleTimeoutSecs: 60n,
        },
      }),
    },
  });
  assert.match(els.screen.innerHTML, /n=7/);
  assert.match(els.screen.innerHTML, /Pass/);
});

test("onmessage: an err shows the error banner and leaves the screen untouched", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });
  const before = els.screen.innerHTML;

  ws.onmessage!({ data: { err: { seatTaken: null } } });
  assert.equal(els.error.textContent, "That seat is already taken.");
  assert.equal(els.error.hidden, false);
  assert.equal(els.screen.innerHTML, before);
});

test("onmessage: identical consecutive statuses are only rendered once (dedup)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  let writes = 0;
  let stored = els.screen.innerHTML;
  Object.defineProperty(els.screen, "innerHTML", {
    get: () => stored,
    set: (v: string) => {
      writes++;
      stored = v;
    },
  });

  const view: WsPayload = { view: browsing() };
  ws.onmessage!({ data: view });
  ws.onmessage!({ data: view });
  ws.onmessage!({ data: view });
  assert.equal(writes, 1);

  ws.onmessage!({ data: { view: browsing([{ id: 1n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" }]) } });
  assert.equal(writes, 2);
});

test("open-tables list: a row's 'waiting Ns' label counts up locally between pushes (regression: frozen waiting time)", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const { start } = await import("../src/app.js");
    const { els, ws } = setup();
    start({ plugin, ws, session: defaultSession });

    ws.onmessage!({ data: { view: browsing([{ id: 6n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 5n, variant: "" }]) } });
    const row = els.screen.querySelectorAll("[data-wait-base]")[0];
    assert.ok(row, "expected a rendered wait-ticker element");
    assert.equal(row!.textContent, "waiting 5s");

    // No fresh push arrives — only the local ticker should move this.
    mock.timers.tick(3000);
    assert.equal(row!.textContent, "waiting 8s");

    // A fresh push with a redrawn (but otherwise identical) row
    // re-baselines the ticker off the NEW node rather than going on
    // patching a stale, now-detached one from the previous render.
    ws.onmessage!({ data: { view: browsing([{ id: 6n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 20n, variant: "" }]) } });
    const freshRow = els.screen.querySelectorAll("[data-wait-base]")[0];
    assert.ok(freshRow, "expected a freshly rendered wait-ticker element");
    assert.equal(freshRow!.textContent, "waiting 20s");
    mock.timers.tick(2000);
    assert.equal(freshRow!.textContent, "waiting 22s");
  } finally {
    mock.timers.reset();
  }
});

test("clicking 'create table' calls ws.request with a createTable request and shows/clears the loading state", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ createTable: "p1" });
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { createTable: { seat: { p1: null }, visibility: { open: null }, variant: "" } });
  assert.ok(btn.classList.contains("duel-loading"));
  assert.ok(doc.body.classList.contains("working"));

  ws.requests[0]!.resolve({ view: browsing() });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.body.classList.contains("working"), false);
});

test("a button's spinner survives an unrelated re-render that arrives before its own call settles (regression: two players taking seats at once)", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  // Initial lobby: nobody's created a table yet.
  ws.onmessage!({ data: { view: browsing() } });

  const p2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p2");
  assert.ok(p2Btn, "expected a rendered 'create table as p2' button");

  // Player B clicks "start a table as p2".
  click(els.screen, p2Btn!);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { createTable: { seat: { p2: null }, visibility: { open: null }, variant: "" } });
  assert.ok(p2Btn!.classList.contains("duel-loading"));

  // Before B's own call resolves, an unrelated push tick lands — e.g. a
  // brand new open table someone else just created — and redraws the
  // whole screen. This is exactly the bug report's sequence: B's own
  // call is still in flight when this arrives.
  ws.onmessage!({ data: { view: browsing([{ id: 7n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" }]) } });

  // The old p2Btn node is gone (the screen was redrawn); the freshly
  // rendered one occupying its slot must still show as busy — not
  // silently enabled again just because it's a new node.
  const freshP2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p2");
  assert.ok(freshP2Btn, "expected a freshly rendered 'create table as p2' button");
  assert.notEqual(freshP2Btn, p2Btn, "sanity: the re-render actually replaced the node");
  assert.equal(freshP2Btn!.disabled, true, "still-pending button must stay disabled");
  assert.ok(
    freshP2Btn!.classList.contains("duel-loading"),
    "still-pending button must keep its spinner",
  );
  assert.ok(doc.body.classList.contains("working"), "cursor should still read busy too");

  // B's own call finally resolves.
  ws.requests[0]!.resolve({
    view: atTable({ stagingYou: { seat: { p2: null }, reservedForPartner: false, secondsUntilReclaimable: 999n, gen: 1n, visibility: { open: null } } }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.body.classList.contains("working"), false);
});

test("the create-table form's live input survives an unrelated push mid-fill (regression: a lobby refresh silently discards Protected)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing() } });

  // The player picks Protected and types a code — none of it submitted
  // yet. Mutual radio exclusivity is the browser's own job, not modeled
  // by this fake, so flip both sides by hand the way a real click would.
  const radios = els.screen.children.filter((c) => c.tagName === "input" && c.name === "table-visibility");
  radios.find((r) => r.value === "open")!.checked = false;
  radios.find((r) => r.value === "code")!.checked = true;
  (els.screen.children.find((c) => c.id === "create-code") as { value: string }).value = "TOP-SECRET";

  // An unrelated push lands before the click — e.g. another player
  // opening or leaving a table — while the form is still mid-fill.
  ws.onmessage!({ data: { view: browsing([{ id: 9n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 3n, variant: "" }]) } });

  const freshRadios = els.screen.children.filter((c) => c.tagName === "input" && c.name === "table-visibility");
  assert.equal(freshRadios.find((r) => r.value === "code")!.checked, true, "Protected must still be selected after the redraw");
  assert.equal(freshRadios.find((r) => r.value === "open")!.checked, false);
  const freshCode = els.screen.children.find((c) => c.id === "create-code")!;
  assert.equal(freshCode.value, "TOP-SECRET", "the typed access code must survive the redraw");
  assert.equal(freshCode.hidden, false, "the code box must stay visible, matching the restored choice");

  // The click now submitted really does carry Protected + the typed
  // code, not the defaults renderBrowsing() baked into the fresh markup.
  const seatBtn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  click(els.screen, seatBtn!);
  assert.deepEqual(ws.requests[0]!.req, {
    createTable: { seat: { p1: null }, visibility: { code: "TOP-SECRET" }, variant: "" },
  });
});

test("clicking 'create table' with Protected chosen but no code entered shows a friendly error and never dispatches (regression: an empty access code makes an unjoinable table)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing() } });

  const radios = els.screen.children.filter((c) => c.tagName === "input" && c.name === "table-visibility");
  radios.find((r) => r.value === "open")!.checked = false;
  radios.find((r) => r.value === "code")!.checked = true;
  // create-code is left blank — the exact bug repro.

  const seatBtn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  click(els.screen, seatBtn!);

  assert.equal(ws.requests.length, 0, "an empty access code must never even be sent to the engine");
  assert.equal(els.error.textContent, "Enter an access code, or choose Open.");
  assert.equal(els.error.hidden, false);
  assert.equal(seatBtn!.disabled, false, "the button must not be left stuck spinning/disabled");
});

test("clicking an open seat on a protected table row prompts for the access code before joining", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: browsing([
        { id: 9n, p1Open: true, p2Open: false, p1Session: [], p2Session: ["carol"], protected: true, waitingSecs: 3n, variant: "" },
      ]),
    },
  });

  const seatBtn = els.screen
    .querySelectorAll("button")
    .find((b) => b.dataset.joinTableId === "9" && b.dataset.joinTable === "p1")!;
  assert.ok("protected" in seatBtn.dataset, "an open seat on a protected row must carry data-protected");
  click(els.screen, seatBtn);
  assert.equal(ws.requests.length, 0, "must not join before a code is entered");

  // The access-code overlay is appended straight to document.body — find
  // it there, same idiom as the confirmation modal.
  const overlay = doc.body.children.find((c) => c.className === "duel-code-overlay")!;
  assert.equal(overlay.hidden, false);
  const input = overlay.querySelector(".duel-code-input") as { value: string };
  input.value = "friends-only";
  const joinBtn = makeButton({ codeJoin: "" });
  overlay.dispatch("click", { target: joinBtn });

  assert.deepEqual(ws.requests[0]!.req, { joinTable: { id: 9n, seat: { p1: null }, code: ["friends-only"] } });
  assert.equal(overlay.hidden, true);
});

test("cancelling the access-code prompt dispatches nothing", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: browsing([
        { id: 9n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: true, waitingSecs: 0n, variant: "" },
      ]),
    },
  });

  const seatBtn = els.screen
    .querySelectorAll("button")
    .find((b) => b.dataset.joinTableId === "9" && b.dataset.joinTable === "p1")!;
  click(els.screen, seatBtn);

  const overlay = doc.body.children.find((c) => c.className === "duel-code-overlay")!;
  const cancelBtn = makeButton({ codeCancel: "" });
  overlay.dispatch("click", { target: cancelBtn });
  assert.equal(ws.requests.length, 0);
  assert.equal(overlay.hidden, true);
});

test("an open table's own seat button (no data-protected) joins directly, without a code prompt", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: browsing([
        { id: 4n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" },
      ]),
    },
  });

  const seatBtn = els.screen
    .querySelectorAll("button")
    .find((b) => b.dataset.joinTableId === "4" && b.dataset.joinTable === "p2")!;
  assert.ok(!("protected" in seatBtn.dataset));
  click(els.screen, seatBtn);

  assert.deepEqual(ws.requests[0]!.req, { joinTable: { id: 4n, seat: { p2: null }, code: [] } });
  const overlay = doc.body.children.find((c) => c.className === "duel-code-overlay")!;
  assert.equal(overlay.hidden, true, "the code prompt must never appear for an open table");
});

test("a submit action button round-trips its data-act JSON verbatim", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ act: JSON.stringify({ shoot: { power: 2 } }) });
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { submit: { gen: 0n, turn: 0n, move: { shoot: { power: 2 } } } });
});

test("plugin.applyLocal: the move shows as soon as it is submitted, and a rejection puts the real board back", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const local: GamePlugin<{ n: number }> = {
    ...plugin,
    applyLocal: (game, _seat, move) => ((move as { add?: number }).add ? { n: game.n + 1 } : null),
  };
  start({ plugin: local, ws, session: defaultSession });
  const live = (n: number, turn: bigint) =>
    atTable({
      inGame: {
        mode: { alternating: null },
        seat: { p1: null },
        game: { n },
        turn,
        youSubmitted: false,
        oppSubmitted: true,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
        claimWinAvailable: false,
        secondsUntilClaimable: 20n,
        claimTimeoutSecs: 20n,
      },
    });
  ws.onmessage!({ data: { view: live(7, 4n) } });

  click(els.screen, makeButton({ act: JSON.stringify({ add: 1 }) }));
  assert.match(els.screen.innerHTML, /n=8/);
  assert.match(els.screen.innerHTML, /Opponent's turn/);
  assert.match(els.screen.innerHTML, /Move <strong>6<\/strong>/);

  ws.requests[0]!.resolve({ err: { illegalMove: "no" } });
  await new Promise((r) => setImmediate(r));
  assert.match(els.screen.innerHTML, /n=7/);
  assert.match(els.screen.innerHTML, /Your turn/);

  // null from applyLocal: the board stays as it is while in flight.
  click(els.screen, makeButton({ act: JSON.stringify({ pass: null }) }));
  assert.match(els.screen.innerHTML, /n=7/);
});

test("a disabled button never dispatches", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ leave: "" });
  btn.disabled = true;
  click(els.screen, btn);
  assert.equal(ws.requests.length, 0);
});

test("a second click while a call is in flight is ignored (no double-submit)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ rematch: "" });
  click(els.screen, btn);
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
});

test("a data-confirm button waits for confirmation before dispatching", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ leave: "" });
  btn.dataset.confirm = "Forfeit this game? Your opponent will win.";
  click(els.screen, btn);
  assert.equal(ws.requests.length, 0, "must not dispatch before confirmation");

  // The confirm overlay is appended straight to document.body — find it there.
  const overlay = doc.body.children.find((c) => c.className === "duel-confirm-overlay")!;
  assert.equal(overlay.hidden, false);

  const yesBtn = makeButton({ confirmYes: "" });
  overlay.dispatch("click", { target: yesBtn });
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { leave: { gen: 0n } });
  assert.equal(overlay.hidden, true);
});

test("a data-confirm button dispatches nothing if cancelled", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ leave: "" });
  btn.dataset.confirm = "Forfeit?";
  click(els.screen, btn);

  const overlay = doc.body.children.find((c) => c.className === "duel-confirm-overlay")!;
  const noBtn = makeButton({ confirmNo: "" });
  overlay.dispatch("click", { target: noBtn });
  assert.equal(ws.requests.length, 0);
  assert.equal(overlay.hidden, true);
});

test("declining a rematch invite (Decline, from #awaitingRematch) sends its own gen", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: { view: atTable({ awaitingRematch: { openSeat: { p2: null }, gen: 7n } }) },
  });

  const btn = makeButton({ leave: "" });
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { leave: { gen: 7n } });
});

test("clicking 'Claim the win' sends claimWin with the last-observed gen", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: atTable({
        inGame: {
          mode: { simultaneous: null },
          seat: { p1: null },
          game: { n: 0 },
          turn: 4n,
          youSubmitted: true,
          oppSubmitted: false,
          gen: 3n,
          secondsUntilIdleReset: 40n,
          idleTimeoutSecs: 60n,
          claimWinAvailable: true,
          secondsUntilClaimable: 0n,
          claimTimeoutSecs: 20n,
        },
      }),
    },
  });

  const btn = els.screen.querySelectorAll("button").find((b) => "claimWin" in b.dataset);
  assert.ok(btn, "expected a rendered Claim the win button");
  click(els.screen, btn!);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { claimWin: { gen: 3n } });
});

test("the 'Claim the win' button reveals itself locally once the countdown reaches zero, without waiting for a fresh push (regression: button never appeared)", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const { start } = await import("../src/app.js");
    const { els, ws } = setup();
    start({ plugin, ws, session: defaultSession });

    ws.onmessage!({
      data: {
        view: atTable({
          inGame: {
            mode: { simultaneous: null },
            seat: { p1: null },
            game: { n: 0 },
            turn: 4n,
            youSubmitted: true,
            oppSubmitted: false,
            gen: 5n,
            secondsUntilIdleReset: 40n,
            idleTimeoutSecs: 60n,
            // Not yet claimable as of this push — nothing changes it
            // server-side until the NEXT push, which (per the engine's
            // own push model) only ever arrives off a mutation or the
            // idle sweep, neither of which fires just because 3s passed.
            claimWinAvailable: false,
            secondsUntilClaimable: 3n,
            claimTimeoutSecs: 20n,
          },
        }),
      },
    });

    const btn = els.screen.querySelectorAll("button").find((b) => "claimWin" in b.dataset);
    assert.ok(btn, "expected a rendered Claim the win button");
    assert.equal(btn!.hidden, true, "must start hidden — not yet claimable as of the last push");

    // No fresh push arrives — only the local ticker should reveal it.
    mock.timers.tick(3000);
    assert.equal(btn!.hidden, false, "should reveal itself once the local countdown reaches zero");

    click(els.screen, btn!);
    assert.equal(ws.requests.length, 1);
    assert.deepEqual(ws.requests[0]!.req, { claimWin: { gen: 5n } });
  } finally {
    mock.timers.reset();
  }
});

test("the still-deciding player never gets a Claim button of their own — not initially, and not once the claim window has fully elapsed (only the 'atRisk' warning text, covered in render.test.ts, is theirs)", async () => {
  // The claim-win countdown TEXT itself (`<p class="countdown">`, unlike the
  // `<button>` this fake DOM parses
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const { start } = await import("../src/app.js");
    const { els, ws } = setup();
    start({ plugin, ws, session: defaultSession });

    ws.onmessage!({
      data: {
        view: atTable({
          inGame: {
            mode: { simultaneous: null },
            seat: { p1: null },
            game: { n: 0 },
            turn: 4n,
            youSubmitted: false, // THIS seat hasn't moved
            oppSubmitted: true, // the opponent has
            gen: 5n,
            secondsUntilIdleReset: 40n,
            idleTimeoutSecs: 60n,
            claimWinAvailable: false, // always false from this seat's own view
            secondsUntilClaimable: 3n,
            claimTimeoutSecs: 20n, // threshold = min(15, 10) = 10 — 3s is already inside it
          },
        }),
      },
    });

    const claimBtn = () => els.screen.querySelectorAll("button").find((b) => "claimWin" in b.dataset);
    assert.equal(claimBtn(), undefined, "no Claim button for the still-deciding player from the start");

    // No fresh push arrives — same as the waiting player's own local
    // reveal, this must stay driven by the local clock, and here that
    // means staying absent the whole time, not eventually appearing.
    mock.timers.tick(3000);
    assert.equal(claimBtn(), undefined, "still no Claim button once the claim window has locally elapsed");
  } finally {
    mock.timers.reset();
  }
});

test("the new-sid button calls session.regenerate() and disables itself while the call is in flight", async () => {
  const { start } = await import("../src/app.js");
  const { els } = setup();
  let regenerateCalls = 0;
  let resolveRegenerate!: () => void;
  const session = fakeSession({
    isLoggedIn: false,
    regenerate: () =>
      new Promise<void>((resolve) => {
        regenerateCalls++;
        resolveRegenerate = resolve;
      }),
  });
  start({ plugin, ws: new FakeWs(), session });

  assert.equal(els["new-sid"].disabled, false);
  els["new-sid"].dispatch("click", {});
  assert.equal(regenerateCalls, 1);
  assert.equal(els["new-sid"].disabled, true, "disabled immediately while regenerate() is in flight");
  resolveRegenerate();
});

test("the new-sid button is disabled while the sid holds a seat, and ignores clicks then", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let regenerateCalls = 0;
  const session = fakeSession({
    isLoggedIn: false,
    regenerate: async () => {
      regenerateCalls++;
    },
  });
  start({ plugin, ws, session });

  const seated = [
    atTable({ stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 30n, gen: 1n, visibility: { open: null } } }),
    atTable({
      inGame: {
        mode: { simultaneous: null },
        seat: { p1: null },
        game: { n: 0 },
        turn: 0n,
        youSubmitted: false,
        oppSubmitted: false,
        gen: 1n,
        secondsUntilIdleReset: 60n,
        idleTimeoutSecs: 60n,
      },
    }),
    atTable({
      debrief: {
        seat: { p1: null },
        end: { finished: { p1Wins: null } },
        turns: 1n,
        finalGame: { n: 0 },
        gen: 1n,
      },
    }),
  ];
  for (const view of seated) {
    ws.onmessage!({ data: { view } });
    assert.equal(els["new-sid"].disabled, true, Object.keys((view as { atTable: { view: object } }).atTable.view)[0]);
  }

  els["new-sid"].dispatch("click", {});
  assert.equal(regenerateCalls, 0, "a disabled new-sid must never call regenerate()");

  const unseated = [
    browsing(),
    atTable({ busy: { secondsUntilTakeover: 5n } }),
    atTable({ awaitingRematch: { openSeat: { p1: null }, gen: 1n } }),
    atTable({ endedByOther: null }),
  ];
  for (const view of unseated) {
    ws.onmessage!({ data: { view } });
    assert.equal(els["new-sid"].disabled, false, Object.keys(view)[0]);
  }

  els["new-sid"].dispatch("click", {});
  assert.equal(regenerateCalls, 1);
});

test("the new-sid button disables the instant a create-table request is dispatched, not only once it resolves (regression: click new-sid mid-join soft-locks the seat)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let regenerateCalls = 0;
  const session = fakeSession({ isLoggedIn: false, regenerate: async () => { regenerateCalls++; } });
  start({ plugin, ws, session });

  // Browsing: nobody's created a table yet — new-sid starts out enabled.
  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(els["new-sid"].disabled, false);

  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  assert.ok(p1Btn, "expected a rendered 'create table as p1' button");

  // Click "start a table" — the request is now in flight, under the
  // current sid, but nothing has confirmed the seat yet.
  click(els.screen, p1Btn!);
  assert.equal(ws.requests.length, 1);

  // new-sid must already be disabled
  assert.equal(els["new-sid"].disabled, true);
  els["new-sid"].dispatch("click", {});
  assert.equal(regenerateCalls, 0, "must not call regenerate() while the request is in flight");

  // The call succeeds; the confirmed seat keeps new-sid disabled as usual.
  ws.requests[0]!.resolve({
    view: atTable({ stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 999n, gen: 1n, visibility: { open: null } } }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, true);
});

test("the new-sid button re-enables after a rejected join request", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing([{ id: 1n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" }]) } });
  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.joinTable === "p1" && b.dataset.joinTableId === "1");
  assert.ok(p1Btn, "expected a rendered join button for table #1's p1 seat");

  click(els.screen, p1Btn!);
  assert.equal(els["new-sid"].disabled, true, "eagerly disabled the moment the join went out");

  // Someone else took the seat first — the join comes back rejected. The
  // status never changed (still not seated), so renderIfChanged's own
  // resync (off the *new* status) never runs; the error path must resync
  // new-sid off the last-known status itself.
  ws.requests[0]!.resolve({ err: { seatTaken: null } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, false, "must not stay stuck disabled after a failed join");
});

test("call() recovers if ws.request() throws synchronously instead of rejecting (regression: no guard around the correlated request path — carried-forward finding 07/N7)", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing() } });
  // A misbehaving (or simply different — DuelWs.request is a
  // caller-supplied surface, not just the bundled GatewayWs) transport
  // that throws instead of returning a rejected promise — exactly the
  // shape `sendWs()`'s own try/catch already guards against for `send`.
  ws.request = () => {
    throw new Error("boom");
  };

  const btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  click(els.screen, btn!);

  assert.equal(els.error.textContent, "Call failed: boom");
  assert.equal(els.error.hidden, false);
  assert.equal(doc.body.classList.contains("working"), false, "must not stay stuck spinning");
  assert.equal(btn!.disabled, false, "must not stay stuck disabled");
});

test("the new-sid button stays disabled through an unrelated push arriving mid-join (regression: rival's move landing first briefly re-enables new-sid)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  // Browsing: one open table, both seats free.
  ws.onmessage!({ data: { view: browsing([{ id: 1n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" }]) } });

  // This player (B) clicks "join as p2" on that table — their own call
  // is now in flight, correlated via ws.request().
  const p2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.joinTable === "p2" && b.dataset.joinTableId === "1");
  assert.ok(p2Btn, "expected a rendered join button for table #1's p2 seat");
  click(els.screen, p2Btn!);
  assert.equal(ws.requests.length, 1);
  assert.equal(els["new-sid"].disabled, true, "eagerly disabled the moment B's own request went out");

  // Before B's own call resolves, an UNRELATED push tick lands
  ws.onmessage!({
    data: {
      view: browsing([
        { id: 1n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" },
        { id: 2n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" },
      ]),
    },
  });
  assert.equal(
    els["new-sid"].disabled,
    true,
    "must stay disabled — B's own request is still pending, regardless of what an unrelated push shows",
  );

  // B's own request finally resolves — new-sid stays disabled as usual,
  // now because the confirmed status itself is seated.
  ws.requests[0]!.resolve({
    view: atTable({ stagingYou: { seat: { p2: null }, reservedForPartner: false, secondsUntilReclaimable: 999n, gen: 1n, visibility: { open: null } } }),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, true);
});

test("a createTable rejected as wrongPhase (stale status — already seated elsewhere) resyncs silently instead of showing an error", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing() } });
  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  assert.ok(p1Btn, "expected a rendered 'create table as p1' button");
  click(els.screen, p1Btn!);

  // Lobby.createTable's only #wrongPhase case is "already at another
  // table" — see isStaleJoin's own doc in app.ts.
  ws.requests[0]!.resolve({ err: { wrongPhase: "you are already at another table" } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(els.error.textContent, "", "must not surface an error the user can't act on");
  assert.equal(ws.sent.length, 2, "resyncs by re-sending #status, not by ws.request()");
  assert.deepEqual(ws.sent[1]!.req, { status: null });
});

test("a createTable rejected as wrongPhase resyncs even without ws.request (fallback transport)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup({ withRequest: false });
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({ data: { view: browsing() } });
  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable === "p1");
  assert.ok(p1Btn, "expected a rendered 'create table as p1' button");
  click(els.screen, p1Btn!);
  assert.deepEqual(ws.sent[1]!.req, { createTable: { seat: { p1: null }, visibility: { open: null }, variant: "" } });

  ws.onmessage!({ data: { err: { wrongPhase: "you are already at another table" } } });

  assert.equal(els.error.textContent, "", "must not surface an error the user can't act on");
  assert.equal(ws.sent.length, 3, "resyncs by re-sending #status");
  assert.deepEqual(ws.sent[2]!.req, { status: null });
});

test("a wrongPhase rejection from a NON-join request still shows the error banner (regression guard)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  ws.onmessage!({
    data: {
      view: atTable({
        debrief: {
          seat: { p1: null },
          end: { finished: { p1Wins: null } },
          turns: 3n,
          finalGame: { n: 7 },
          gen: 1n,
        },
      }),
    },
  });
  const rematchBtn = els.screen.querySelectorAll("button").find((b) => "rematch" in b.dataset);
  assert.ok(rematchBtn, "expected a rendered rematch button");
  click(els.screen, rematchBtn!);

  // e.g. lib.mo's rematch<S, M> #err(#wrongPhase("your game is already
  // running")) — a real rejection, not a stale-join resync candidate.
  ws.requests[0]!.resolve({ err: { wrongPhase: "your game is already running" } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(els.error.hidden, false);
  assert.equal(els.error.textContent, "your game is already running");
});

test("fallback transport (no ws.request): settles inFlight off the shared onmessage stream", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup({ withRequest: false });
  start({ plugin, ws, session: defaultSession });

  const btn = makeButton({ reset: "" });
  click(els.screen, btn);
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(ws.sent[1]!.req, { reset: { gen: 0n } });
  assert.ok(doc.body.classList.contains("working"));

  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(doc.body.classList.contains("working"), false);
});

test("ws.onerror shows the error banner", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });
  ws.onerror!({ error: new Error("boom") });
  assert.match(els.error.textContent, /WebSocket error: boom/);
});

test("ws.onclose shows a persistent reload prompt and disables every button on the page", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });

  // A real browsing screen first, so there's a page full of clickable
  // buttons (create-table) to prove get disabled — not just an assertion
  // against an empty screen.
  ws.onmessage!({ data: { view: browsing() } });
  const screenButtons = els.screen.querySelectorAll("button");
  assert.ok(screenButtons.length > 0, "the browsing screen should have rendered at least one button");
  assert.ok(screenButtons.every((b) => !b.disabled), "buttons start out clickable");
  assert.equal(els["new-sid"].disabled, false, "not seated yet — new-sid starts enabled");

  ws.onclose!();

  // `innerHTML`, not `textContent`: this banner carries a real reload
  // button, not plain text (see showDisconnected's own doc).
  assert.match(els.error.innerHTML, /Connection closed/);
  assert.equal(els.error.querySelectorAll("button").length, 1, "a reload button should be present");
  assert.equal(els["new-sid"].disabled, true);
  for (const b of els.screen.querySelectorAll("button")) {
    assert.equal(b.disabled, true, "every button must be disabled once disconnected");
  }

  // A stray in-flight rejection landing right after close ("Call failed:
  // GatewayWs: closed", the exact symptom the 007 defect report's
  // finding 04 reproduced) must not clobber the persistent banner with a
  // fresh, auto-hiding toast.
  ws.onerror!({ error: new Error("boom") });
  assert.match(els.error.innerHTML, /Connection closed/);
  assert.doesNotMatch(els.error.innerHTML, /boom/);
});

test("a lost connection shows 'Reconnecting…' with the screen still live, and clears on reopen", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: defaultSession });
  ws.onopen!();
  ws.onmessage!({ data: { view: browsing() } });

  ws.onconnecting!();
  assert.equal(els.error.hidden, false);
  assert.equal(els.error.textContent, "Reconnecting…");
  assert.ok(els.screen.querySelectorAll("button").every((b) => !b.disabled), "calls queue behind the reopen");

  ws.onopen!();
  assert.equal(els.error.hidden, true);
});

test("a logged-in session's sid is used directly, and new-sid is permanently disabled AND hidden", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const session = fakeSession({ sid: "ii:abc123", isLoggedIn: true });
  start({ plugin, ws, session });

  assert.equal(els.sid.textContent, "ii:abc123");
  assert.equal(els["new-sid"].disabled, true);
  assert.equal(els["new-sid"].hidden, true, "a logged-in identity isn't a per-tab thing to switch away from");
  els["new-sid"].dispatch("click", {});
  assert.equal(ws.sent.length, 1, "a disabled new-sid must never dispatch (only the initial #status)");
});

test("an anonymous session's sid is used, and new-sid calls session.regenerate()", async () => {
  const { start } = await import("../src/app.js");
  const { els } = setup();
  let regenerateCalls = 0;
  const session = fakeSession({
    sid: "an:abc",
    isLoggedIn: false,
    regenerate: async () => {
      regenerateCalls++;
    },
  });
  start({ plugin, ws: new FakeWs(), session });

  assert.equal(els.sid.textContent, "an:abc");
  assert.equal(els["new-sid"].disabled, false);
  assert.equal(els["new-sid"].hidden, false);
  els["new-sid"].dispatch("click", {});
  assert.equal(regenerateCalls, 1, "clicking new-sid must call session.regenerate()");
  assert.equal(els["new-sid"].disabled, true, "disabled immediately while regenerate() is in flight");
});

test("new-sid is hidden entirely when session.regenerate isn't provided (a game using anon-identity.js's lighter session directly)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: { sid: "an:bare" } });

  assert.equal(els["new-sid"].disabled, true);
  assert.equal(els["new-sid"].hidden, true);
  els["new-sid"].dispatch("click", {});
  assert.equal(ws.sent.length, 1, "a hidden/disabled new-sid must never dispatch (only the initial #status)");
});

test("a failed session.regenerate() re-enables new-sid and shows an error", async () => {
  const { start } = await import("../src/app.js");
  const { els } = setup();
  const session = fakeSession({
    isLoggedIn: false,
    regenerate: () => Promise.reject(new Error("storage full")),
  });
  start({ plugin, ws: new FakeWs(), session });

  els["new-sid"].dispatch("click", {});
  assert.equal(els["new-sid"].disabled, true, "disabled immediately, before the rejection settles");
  await Promise.resolve().then(() => Promise.resolve());
  assert.equal(els["new-sid"].disabled, false, "re-enabled once the failed attempt settles");
  assert.match(els.error.textContent, /New sid failed/);
});

test("with a session that provides no login/logout, duel-auth-btn is left untouched", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws, session: { sid: "an:bare" } });

  assert.equal(els["duel-auth-btn"].textContent, "");
  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(ws.sent.length, 1, "an unwired button must do nothing (only the initial #status)");
});

test("duel-auth-btn: labeled and wired to session.login() while anonymous", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let loginCalled = false;
  const session = fakeSession({
    isLoggedIn: false,
    login: async () => {
      loginCalled = true;
    },
  });
  start({ plugin, ws, session });

  assert.match(els["duel-auth-btn"].textContent, /Log in/);
  assert.equal(els["duel-auth-btn"].disabled, false);
  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(loginCalled, true);
});

test("duel-auth-btn: labeled and wired to session.logout() while logged in", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let logoutCalled = false;
  const session = fakeSession({
    isLoggedIn: true,
    logout: async () => {
      logoutCalled = true;
    },
  });
  start({ plugin, ws, session });

  assert.match(els["duel-auth-btn"].textContent, /Log out/);
  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(logoutCalled, true);
});

test("duel-auth-btn: a failed login re-enables the button and shows an error, without touching the persistent-disconnect banner", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const session = fakeSession({
    isLoggedIn: false,
    login: () => Promise.reject(new Error("popup closed")),
  });
  start({ plugin, ws, session });

  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(els["duel-auth-btn"].disabled, true, "disabled immediately, before the rejection settles");
  await Promise.resolve().then(() => Promise.resolve()); // let the rejection's .catch() run
  assert.equal(els["duel-auth-btn"].disabled, false, "re-enabled once the failed attempt settles");
  assert.match(els.error.textContent, /Log in failed/);
});

test("duel-auth-btn: a second click while a login is in flight is ignored", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let calls = 0;
  const session = fakeSession({
    isLoggedIn: false,
    login: () => {
      calls++;
      return new Promise<void>(() => {}); // never settles
    },
  });
  start({ plugin, ws, session });

  els["duel-auth-btn"].dispatch("click", {});
  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(calls, 1, "a disabled button must not dispatch a second login attempt");
});

test("duel-auth-btn is disabled together with new-sid once the session holds a seat, and re-enabled once it doesn't", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const session = fakeSession({ isLoggedIn: true });
  start({ plugin, ws, session });

  ws.onmessage!({
    data: {
      view: atTable({
        stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 30n, gen: 1n, visibility: { open: null } },
      }),
    },
  });
  assert.equal(els["new-sid"].disabled, true);
  assert.equal(els["duel-auth-btn"].disabled, true, "auth button must follow new-sid's disabled state");

  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(els["new-sid"].disabled, false);
  assert.equal(els["duel-auth-btn"].disabled, false, "auth button must re-enable once no longer seated");
});

test("duel-auth-btn is disabled the instant a create-table request is dispatched, same as new-sid", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const session = fakeSession({ isLoggedIn: false });
  start({ plugin, ws, session });

  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(els["duel-auth-btn"].disabled, false);

  const createBtn = els.screen.querySelectorAll("button").find((b) => b.dataset.createTable);
  assert.ok(createBtn, "expected a create-table button on the browsing screen");
  click(els.screen, createBtn!);
  assert.equal(els["new-sid"].disabled, true);
  assert.equal(els["duel-auth-btn"].disabled, true);
});

test("duel-auth-btn stays disabled through the persistent disconnected state, same as every other button", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const session = fakeSession({ isLoggedIn: false });
  start({ plugin, ws, session });

  ws.onmessage!({ data: { view: browsing() } });
  assert.equal(els["duel-auth-btn"].disabled, false);

  ws.onclose!();
  assert.equal(els["new-sid"].disabled, true);
  assert.equal(els["duel-auth-btn"].disabled, true);
});

test("a login attempt still in flight is not re-enabled by an unrelated seated/unseated resync", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  let resolveLogin!: () => void;
  const session = fakeSession({
    isLoggedIn: false,
    login: () => new Promise<void>((resolve) => (resolveLogin = resolve)),
  });
  start({ plugin, ws, session });

  ws.onmessage!({ data: { view: browsing() } });
  els["duel-auth-btn"].dispatch("click", {});
  assert.equal(els["duel-auth-btn"].disabled, true, "disabled the instant the click fired");

  // An unrelated push arrives while the login is still pending — must not
  // re-enable a button whose own action hasn't settled yet.
  ws.onmessage!({ data: { view: browsing([{ id: 1n, p1Open: true, p2Open: true, p1Session: [], p2Session: [], protected: false, waitingSecs: 0n, variant: "" }]) } });
  assert.equal(els["duel-auth-btn"].disabled, true, "must stay disabled while its own login is still pending");

  resolveLogin();
});

// ── UI overrides: `screens`, `confirm`, `promptCode`, and the returned client ─

test("start({ screens }) replaces one screen and keeps the rest, with the default click handling intact", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({
    plugin,
    ws,
    session: defaultSession,
    screens: {
      debrief: (v, p) => `<h1 class="mine">${p.seatLabel("p1")} says GG</h1><button data-rematch>Again</button>`,
    },
  });
  assert.match(els.screen.innerHTML, /Connecting/);
  ws.onmessage!({
    data: {
      view: atTable({
        debrief: { seat: { p1: null }, end: { finished: { draw: null } }, turns: 2n, finalGame: { n: 1 }, gen: 3n },
      }),
    },
  });
  assert.match(els.screen.innerHTML, /White says GG/);
  assert.match(els.screen.innerHTML, /Table #1/, "the default table badge still frames the custom screen");
  assert.doesNotMatch(els.screen.innerHTML, /Return to lobby/);
  click(els.screen, makeButton({ rematch: "" }));
  assert.deepEqual(ws.requests[0]!.req, { rematch: null });

  ws.onmessage!({ data: { view: browsing() } });
  assert.match(els.screen.innerHTML, /Duel lobby/, "screens left out keep their defaults");
});

test("start({ confirm }) replaces the confirmation overlay; a resolved false dispatches nothing, true dispatches", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  const asked: string[] = [];
  let answer = false;
  start({
    plugin,
    ws,
    session: defaultSession,
    confirm: async (msg) => {
      asked.push(msg);
      return answer;
    },
  });
  assert.equal(doc.body.children.find((c) => c.className === "duel-confirm-overlay"), undefined, "no default overlay built");

  const btn = makeButton({ leave: "" });
  btn.dataset.confirm = "Forfeit?";
  click(els.screen, btn);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ["Forfeit?"]);
  assert.equal(ws.requests.length, 0);

  answer = true;
  click(els.screen, btn);
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { leave: { gen: 0n } });
});

test("start({ promptCode }) replaces the access-code prompt; null cancels, a string joins with it", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  let code: string | null = null;
  start({ plugin, ws, session: defaultSession, promptCode: async () => code });
  assert.equal(doc.body.children.find((c) => c.className === "duel-code-overlay"), undefined);

  const btn = makeButton({ joinTable: "p2", joinTableId: "5", protected: "" });
  click(els.screen, btn);
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.requests.length, 0);

  code = "hush";
  click(els.screen, btn);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ws.requests[0]!.req, { joinTable: { id: 5n, seat: { p2: null }, code: ["hush"] } });
});

test("start() returns the headless client driving the screen, usable alongside it", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  const client = start({ plugin, ws, session: defaultSession });
  assert.equal(client.sid, defaultSession.sid);
  const p = client.createTable("p1");
  assert.equal(client.getState().pending!.key, "create:p1");
  assert.equal(els["new-sid"].disabled, true, "the shell reflects a call made through the client directly");
  ws.requests[0]!.resolve({ view: browsing() });
  await p;
  assert.equal(els["new-sid"].disabled, false);
  assert.match(els.screen.innerHTML, /Duel lobby/);
});
