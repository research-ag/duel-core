// Unit checks for identity.ts's own pure/DOM-only helpers. `resolveIdentity()`
// itself (AuthClient/Ed25519KeyIdentity wiring) is exercised by the compiled
// `dist/identity.js`'s own type-check and by the reference examples' manual
// smoke tests — not here, since AuthClient's real storage backend
// (IndexedDB) isn't available in this Node test environment, and mocking it
// convincingly would test the mock, not this module. `sidForPrincipal` MUST
// stay byte-for-byte identical to `backend/src/ws.mo`'s own derivation —
// see that file's `Hub.test.mo` for the matching backend-side cases.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PRINCIPAL_SID_PREFIX, sidForPrincipal, resolveAnonymousSid, regenerateAnonymousSid } from "../src/identity.js";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

function setup(search = ""): { storage: FakeStorage } {
  const storage = new FakeStorage();
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = storage;
  (globalThis as unknown as { location: { search: string } }).location = { search };
  return { storage };
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { location?: unknown }).location;
});

test("sidForPrincipal: pure, deterministic, and namespaced", () => {
  const a = sidForPrincipal("abc-def");
  assert.equal(a, sidForPrincipal("abc-def"), "same input must always produce the same sid");
  assert.ok(a.startsWith(PRINCIPAL_SID_PREFIX), "must fall in the reserved namespace");
  assert.notEqual(a, sidForPrincipal("xyz-123"), "distinct principals must not collide");
  assert.equal(sidForPrincipal("abc-def"), "ii:abc-def", "must match backend/src/ws.mo's own derivation exactly");
});

test("resolveAnonymousSid: a fresh random sid is generated and persisted when nothing is stored", () => {
  setup();
  const first = resolveAnonymousSid();
  assert.ok(first.length > 0);
  assert.equal(resolveAnonymousSid(), first, "a second call must return the SAME persisted sid");
});

test("resolveAnonymousSid: a `?sid=` override wins and is remembered", () => {
  setup("?sid=pinned-42");
  assert.equal(resolveAnonymousSid(), "pinned-42");
});

test("regenerateAnonymousSid: discards the old sid for a fresh one, and persists it", () => {
  setup();
  const before = resolveAnonymousSid();
  const after = regenerateAnonymousSid();
  assert.notEqual(after, before);
  assert.equal(resolveAnonymousSid(), after, "the regenerated sid must now be the persisted one");
});
