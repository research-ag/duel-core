// Unit checks for anon-identity.ts's persisted-keypair anonymous identity.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ANON_SID_PREFIX, regenerateAnonymousIdentity, resolveAnonymousIdentity, sidFor } from "../src/anon-identity.js";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function setup(): { local: FakeStorage; tab: FakeStorage } {
  const local = new FakeStorage();
  const tab = new FakeStorage();
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = local;
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = tab;
  return { local, tab };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

test("sidFor: pure, deterministic, and namespaced by prefix", () => {
  const a = sidFor(ANON_SID_PREFIX, "abc-def");
  assert.equal(a, sidFor(ANON_SID_PREFIX, "abc-def"), "same input must always produce the same sid");
  assert.ok(a.startsWith(ANON_SID_PREFIX), "must fall in the reserved namespace");
  assert.notEqual(a, sidFor(ANON_SID_PREFIX, "xyz-123"), "distinct principals must not collide");
  assert.equal(sidFor(ANON_SID_PREFIX, "abc-def"), "an:abc-def", "must match backend/src/transport.mo's own derivation exactly");
});

test("resolveAnonymousIdentity: a fresh keypair is generated and persisted when nothing is stored", () => {
  setup();
  const first = resolveAnonymousIdentity();
  assert.ok(first.sid.startsWith(ANON_SID_PREFIX));
  assert.equal(first.sid, sidFor(ANON_SID_PREFIX, first.principal.toText()), "sid must be derived from the identity's own principal");

  const second = resolveAnonymousIdentity();
  assert.equal(second.sid, first.sid, "a second call must reuse the SAME persisted keypair, not mint a new one");
  assert.ok(first.principal.toText() === second.principal.toText());
});

test("resolveAnonymousIdentity: the browser's keypair round-trips through localStorage, so a new tab is the same player", () => {
  const { local } = setup();
  const first = resolveAnonymousIdentity();
  const stored = local.getItem("anon-identity");
  assert.ok(stored, "the keypair must actually be written to localStorage");

  // A new tab: the same localStorage, an empty sessionStorage.
  const { local: local2 } = setup();
  local2.setItem("anon-identity", stored!);
  const otherTab = resolveAnonymousIdentity();
  assert.equal(otherTab.sid, first.sid, "a second tab must play as the same player");
});

test("regenerateAnonymousIdentity: gives this tab a keypair of its own and leaves the browser's alone", () => {
  const { local, tab } = setup();
  const before = resolveAnonymousIdentity();
  const browserKey = local.getItem("anon-identity");
  const after = regenerateAnonymousIdentity();
  assert.notEqual(after.sid, before.sid);
  assert.equal(resolveAnonymousIdentity().sid, after.sid, "this tab now plays as the regenerated identity");
  assert.equal(local.getItem("anon-identity"), browserKey, "other tabs keep the browser's player");
  assert.ok(tab.getItem("anon-identity"), "the tab's own keypair survives its reloads");
});

test("resolveAnonymousIdentity: a tab's own keypair (a pre-existing sessionStorage one included) wins over the browser's", () => {
  const { tab } = setup();
  const browser = resolveAnonymousIdentity();
  const browserKey = (globalThis as unknown as { localStorage: FakeStorage }).localStorage.getItem("anon-identity")!;
  const own = regenerateAnonymousIdentity();
  const stored = tab.getItem("anon-identity")!;
  const { local, tab: reloaded } = setup();
  local.setItem("anon-identity", browserKey);
  reloaded.setItem("anon-identity", stored);
  assert.equal(resolveAnonymousIdentity().sid, own.sid, "with valid keys in both stores, the tab's wins");
  assert.notEqual(own.sid, browser.sid);
});

test("regenerateAnonymousIdentity: without session storage it throws instead of a silent reload", () => {
  const { local } = setup();
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  const before = resolveAnonymousIdentity();
  assert.throws(() => regenerateAnonymousIdentity(), /cannot have a player of its own/);
  assert.equal(resolveAnonymousIdentity().sid, before.sid);
  assert.ok(local.getItem("anon-identity"));
});

test("resolveAnonymousIdentity: blocked storage still yields a working identity", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  const identity = resolveAnonymousIdentity();
  assert.ok(identity.sid.startsWith(ANON_SID_PREFIX));
});

test("resolveAnonymousIdentity: a corrupt stored value is discarded, not thrown", () => {
  const { local } = setup();
  local.setItem("anon-identity", "not valid json");
  const identity = resolveAnonymousIdentity();
  assert.ok(identity.sid.startsWith(ANON_SID_PREFIX));
});
