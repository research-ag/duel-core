import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeElement, makeFakeDocument, makeButton } from "./support/fake-dom.js";
import type { DuelWs, GamePlugin, WsPayload, WsRequest } from "../src/types.js";

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

function setup(opts: { withRequest?: boolean } = {}) {
  const els = {
    sid: new FakeElement(),
    "new-sid": new FakeElement(),
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

test("start(): throws without plugin or ws", async () => {
  const { start } = await import("../src/app.js");
  setup();
  assert.throws(() => start({ plugin: undefined as never, ws: new FakeWs() }), /`plugin` is required/);
  assert.throws(() => start({ plugin, ws: undefined as never }), /`ws` is required/);
});

test("start(): throws a clear error when the screen element is missing", async () => {
  const { start } = await import("../src/app.js");
  const doc = makeFakeDocument({}); // no "screen" element registered
  (globalThis as unknown as { document: typeof doc }).document = doc;
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = new FakeStorage();
  (globalThis as unknown as { location: { search: string } }).location = { search: "" };
  assert.throws(() => start({ plugin, ws: new FakeWs() }), /no element with id "screen"/);
});

test("start(): shows a connecting placeholder immediately, then sends #status on ws.onopen", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });
  assert.match(els.screen.innerHTML, /Connecting/);

  ws.onopen!();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.sent[0]!.req, { status: null });
});

test("onmessage: a pushed view renders via the plugin", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  ws.onmessage!({ data: { view: { inGame: { seat: { p1: null }, game: { n: 7 }, turn: 0n, youSubmitted: false, oppSubmitted: false } } } });
  assert.match(els.screen.innerHTML, /n=7/);
  assert.match(els.screen.innerHTML, /Pass/);
});

test("onmessage: an err shows the error banner and leaves the screen untouched", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });
  const before = els.screen.innerHTML;

  ws.onmessage!({ data: { err: { seatTaken: null } } });
  assert.equal(els.error.textContent, "That seat is already taken.");
  assert.equal(els.error.hidden, false);
  assert.equal(els.screen.innerHTML, before);
});

test("onmessage: identical consecutive views are only rendered once (dedup)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  let writes = 0;
  let stored = els.screen.innerHTML;
  Object.defineProperty(els.screen, "innerHTML", {
    get: () => stored,
    set: (v: string) => {
      writes++;
      stored = v;
    },
  });

  const view: WsPayload = { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } };
  ws.onmessage!({ data: view });
  ws.onmessage!({ data: view });
  ws.onmessage!({ data: view });
  assert.equal(writes, 1);

  ws.onmessage!({ data: { view: { lobby: { p1Open: false, p2Open: true, resetAvailable: false } } } });
  assert.equal(writes, 2);
});

test("clicking a seat button calls ws.request with the join request and shows/clears the loading state", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws });

  const btn = makeButton({ join: "p1" });
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { join: { p1: null } });
  assert.ok(btn.classList.contains("duel-loading"));
  assert.ok(doc.body.classList.contains("working"));

  ws.requests[0]!.resolve({ view: { lobby: { p1Open: false, p2Open: true, resetAvailable: false } } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.body.classList.contains("working"), false);
});

test("a button's spinner survives an unrelated re-render that arrives before its own call settles (regression: two players taking seats at once)", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws });

  // Initial lobby: both seats open.
  ws.onmessage!({ data: { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } } });

  const p2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.join === "p2");
  assert.ok(p2Btn, "expected a rendered p2 seat button");

  // Player B clicks "take seat 2".
  click(els.screen, p2Btn!);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { join: { p2: null } });
  assert.ok(p2Btn!.classList.contains("duel-loading"));

  // Before B's own join resolves, an unrelated push tick lands — e.g.
  // player A's own join, seating p1 — and redraws the whole screen.
  // This is exactly the bug report's sequence: B's join is still in
  // flight when this arrives.
  ws.onmessage!({ data: { view: { lobby: { p1Open: false, p2Open: true, resetAvailable: false } } } });

  // The old p2Btn node is gone (the screen was redrawn); the freshly
  // rendered one occupying its slot must still show as busy — not
  // silently enabled again just because it's a new node.
  const freshP2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.join === "p2");
  assert.ok(freshP2Btn, "expected a freshly rendered p2 seat button");
  assert.notEqual(freshP2Btn, p2Btn, "sanity: the re-render actually replaced the node");
  assert.equal(freshP2Btn!.disabled, true, "still-pending seat button must stay disabled");
  assert.ok(
    freshP2Btn!.classList.contains("duel-loading"),
    "still-pending seat button must keep its spinner",
  );
  assert.ok(doc.body.classList.contains("working"), "cursor should still read busy too");

  // B's own join finally resolves.
  ws.requests[0]!.resolve({
    view: { stagingYou: { seat: { p2: null }, reservedForPartner: false, secondsUntilReclaimable: 999n } },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doc.body.classList.contains("working"), false);
});

test("a submit action button round-trips its data-act JSON verbatim", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  const btn = makeButton({ act: JSON.stringify({ shoot: { power: 2 } }) });
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
  assert.deepEqual(ws.requests[0]!.req, { submit: { shoot: { power: 2 } } });
});

test("a disabled button never dispatches", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  const btn = makeButton({ leave: "" });
  btn.disabled = true;
  click(els.screen, btn);
  assert.equal(ws.requests.length, 0);
});

test("a second click while a call is in flight is ignored (no double-submit)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  const btn = makeButton({ rematch: "" });
  click(els.screen, btn);
  click(els.screen, btn);
  assert.equal(ws.requests.length, 1);
});

test("a data-confirm button waits for confirmation before dispatching", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws });

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
  assert.deepEqual(ws.requests[0]!.req, { leave: null });
  assert.equal(overlay.hidden, true);
});

test("a data-confirm button dispatches nothing if cancelled", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup();
  start({ plugin, ws });

  const btn = makeButton({ leave: "" });
  btn.dataset.confirm = "Forfeit?";
  click(els.screen, btn);

  const overlay = doc.body.children.find((c) => c.className === "duel-confirm-overlay")!;
  const noBtn = makeButton({ confirmNo: "" });
  overlay.dispatch("click", { target: noBtn });
  assert.equal(ws.requests.length, 0);
  assert.equal(overlay.hidden, true);
});

test("the new-sid button rotates sid and re-sends #status", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  const before = els.sid.textContent;
  els["new-sid"].dispatch("click", {});
  assert.notEqual(els.sid.textContent, before);
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.sent[0]!.req, { status: null });
  assert.equal(ws.sent[0]!.sid, els.sid.textContent);
});

test("the new-sid button is disabled while the sid holds a seat, and ignores clicks then", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  const seated = [
    { stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 30n } },
    { inGame: { seat: { p1: null }, game: { n: 0 }, turn: 0n, youSubmitted: false, oppSubmitted: false } },
    {
      debrief: {
        seat: { p1: null },
        end: { finished: { p1Wins: null } },
        turns: 1n,
        finalGame: { n: 0 },
      },
    },
  ];
  for (const view of seated) {
    ws.onmessage!({ data: { view } });
    assert.equal(els["new-sid"].disabled, true, Object.keys(view)[0]);
  }

  const before = els.sid.textContent;
  els["new-sid"].dispatch("click", {});
  assert.equal(els.sid.textContent, before);
  assert.equal(ws.sent.length, 0);

  const unseated = [
    { lobby: { p1Open: true, p2Open: true, resetAvailable: false } },
    { busy: { secondsUntilTakeover: 5n } },
    { awaitingRematch: { openSeat: { p1: null } } },
    { endedByOther: null },
  ];
  for (const view of unseated) {
    ws.onmessage!({ data: { view } });
    assert.equal(els["new-sid"].disabled, false, Object.keys(view)[0]);
  }

  els["new-sid"].dispatch("click", {});
  assert.notEqual(els.sid.textContent, before);
});

test("the new-sid button disables the instant a seat request is dispatched, not only once it resolves (regression: click new-sid mid-join soft-locks the seat)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  // Lobby: both seats open, sid not seated — new-sid starts out enabled.
  ws.onmessage!({ data: { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } } });
  assert.equal(els["new-sid"].disabled, false);

  const before = els.sid.textContent;
  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.join === "p1");
  assert.ok(p1Btn, "expected a rendered p1 seat button");

  // Click "take seat" — the join is now in flight, still under the OLD
  // sid, but nothing has confirmed the seat yet.
  click(els.screen, p1Btn!);
  assert.equal(ws.requests.length, 1);

  // new-sid must already be disabled — waiting for the join's own
  // response (which only flips SEATED_VIEW_TAGS on) would leave a window
  // where clicking it rotates sid out from under the still-in-flight
  // join, stranding the seat on a sid the page no longer tracks.
  assert.equal(els["new-sid"].disabled, true);
  els["new-sid"].dispatch("click", {});
  assert.equal(els.sid.textContent, before, "sid must not rotate while the seat request is in flight");

  // The join succeeds; the confirmed seat keeps new-sid disabled as usual.
  ws.requests[0]!.resolve({
    view: { stagingYou: { seat: { p1: null }, reservedForPartner: false, secondsUntilReclaimable: 999n } },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, true);
});

test("the new-sid button re-enables after a rejected seat request", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  ws.onmessage!({ data: { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } } });
  const p1Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.join === "p1");
  assert.ok(p1Btn, "expected a rendered p1 seat button");

  click(els.screen, p1Btn!);
  assert.equal(els["new-sid"].disabled, true, "eagerly disabled the moment the join went out");

  // Someone else took the seat first — the join comes back rejected. The
  // view never changed (still not seated), so renderIfChanged's own
  // resync (off the *new* view) never runs; the error path must resync
  // new-sid off the last-known view itself.
  ws.requests[0]!.resolve({ err: { seatTaken: null } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, false, "must not stay stuck disabled after a failed join");
});

test("the new-sid button stays disabled through an unrelated push arriving mid-join (regression: rival's join landing first briefly re-enables new-sid)", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });

  // Lobby: both seats open.
  ws.onmessage!({ data: { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } } });

  // This player (B) clicks "take seat 2" — their own join is now in
  // flight, correlated via ws.request().
  const p2Btn = els.screen.querySelectorAll("button").find((b) => b.dataset.join === "p2");
  assert.ok(p2Btn, "expected a rendered p2 seat button");
  click(els.screen, p2Btn!);
  assert.equal(ws.requests.length, 1);
  assert.equal(els["new-sid"].disabled, true, "eagerly disabled the moment B's own join went out");

  // Before B's own join resolves, an UNRELATED push tick lands — player
  // A's own join succeeded first, seating p1. This still renders as
  // "lobby" (unseated) from B's own point of view, since B isn't seated
  // yet either. The old bug: renderIfChanged recomputed new-sid's
  // disabled state off THIS view alone and re-enabled it, opening the
  // exact window where clicking "new" strands B's still-in-flight join
  // under a sid B is about to abandon.
  ws.onmessage!({ data: { view: { lobby: { p1Open: false, p2Open: true, resetAvailable: false } } } });
  assert.equal(
    els["new-sid"].disabled,
    true,
    "must stay disabled — B's own join is still pending, regardless of what an unrelated push shows",
  );

  // B's own join finally resolves — new-sid stays disabled as usual, now
  // because the confirmed view itself is seated.
  ws.requests[0]!.resolve({
    view: { stagingYou: { seat: { p2: null }, reservedForPartner: false, secondsUntilReclaimable: 999n } },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(els["new-sid"].disabled, true);
});

test("fallback transport (no ws.request): settles inFlight off the shared onmessage stream", async () => {
  const { start } = await import("../src/app.js");
  const { els, doc, ws } = setup({ withRequest: false });
  start({ plugin, ws });

  const btn = makeButton({ reset: "" });
  click(els.screen, btn);
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(ws.sent[0]!.req, { reset: null });
  assert.ok(doc.body.classList.contains("working"));

  ws.onmessage!({ data: { view: { lobby: { p1Open: true, p2Open: true, resetAvailable: false } } } });
  assert.equal(doc.body.classList.contains("working"), false);
});

test("ws.onerror shows the error banner", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });
  ws.onerror!({ error: new Error("boom") });
  assert.match(els.error.textContent, /WebSocket error: boom/);
});

test("ws.onclose shows a reload prompt", async () => {
  const { start } = await import("../src/app.js");
  const { els, ws } = setup();
  start({ plugin, ws });
  ws.onclose!();
  assert.match(els.error.textContent, /Connection closed/);
});
