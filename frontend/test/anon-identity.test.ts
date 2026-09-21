// Unit checks for anon-identity.ts's persisted-keypair anonymous
// identity. Real `Ed25519KeyIdentity` generation/serialization (pure
// crypto, no IndexedDB/DOM involved) — unlike `identity.ts`'s
// `AuthClient`-backed branch, this is fully exercisable here.
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

function setup(): { storage: FakeStorage } {
  const storage = new FakeStorage();
  (globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = storage;
  return { storage };
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

test("sidFor: pure, deterministic, and namespaced by prefix", () => {
  const a = sidFor(ANON_SID_PREFIX, "abc-def");
  assert.equal(a, sidFor(ANON_SID_PREFIX, "abc-def"), "same input must always produce the same sid");
  assert.ok(a.startsWith(ANON_SID_PREFIX), "must fall in the reserved namespace");
  assert.notEqual(a, sidFor(ANON_SID_PREFIX, "xyz-123"), "distinct principals must not collide");
  assert.equal(sidFor(ANON_SID_PREFIX, "abc-def"), "an:abc-def", "must match backend/src/ws.mo's own derivation exactly");
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

test("resolveAnonymousIdentity: the persisted keypair round-trips through storage (not just the resolver's own in-memory cache)", () => {
  const { storage } = setup();
  const first = resolveAnonymousIdentity();
  const stored = storage.getItem("anon-identity");
  assert.ok(stored, "the keypair must actually be written to sessionStorage");

  // A fresh "page load": nothing but storage carries over.
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  const { storage: storage2 } = setup();
  storage2.setItem("anon-identity", stored!);
  const reloaded = resolveAnonymousIdentity();
  assert.equal(reloaded.sid, first.sid, "reloading the same stored keypair must reproduce the same sid");
});

test("regenerateAnonymousIdentity: discards the old keypair for a fresh one, and persists it", () => {
  setup();
  const before = resolveAnonymousIdentity();
  const after = regenerateAnonymousIdentity();
  assert.notEqual(after.sid, before.sid);
  assert.equal(resolveAnonymousIdentity().sid, after.sid, "the regenerated identity must now be the persisted one");
});

test("resolveAnonymousIdentity: a corrupt stored value is discarded, not thrown", () => {
  const { storage } = setup();
  storage.setItem("anon-identity", "not valid json");
  const identity = resolveAnonymousIdentity();
  assert.ok(identity.sid.startsWith(ANON_SID_PREFIX));
});
