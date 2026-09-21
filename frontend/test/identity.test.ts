// Unit checks for identity.ts's own pure helpers. `resolveIdentity()`
// itself (AuthClient wiring) is exercised by the compiled `dist/
// identity.js`'s own type-check and by the reference examples' manual
// smoke tests — not here, since AuthClient's real storage backend
// (IndexedDB) isn't available in this Node test environment, and mocking
// it convincingly would test the mock, not this module. Its anonymous
// branch (`resolveAnonymousIdentity`, persisted-keypair generation) is
// covered directly by `anon-identity.test.ts`. `sidForPrincipal` MUST
// stay byte-for-byte identical to `backend/src/ws.mo`'s own derivation —
// see that file's `Hub.test.mo` for the matching backend-side cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRINCIPAL_SID_PREFIX, sidForPrincipal } from "../src/identity.js";

test("sidForPrincipal: pure, deterministic, and namespaced", () => {
  const a = sidForPrincipal("abc-def");
  assert.equal(a, sidForPrincipal("abc-def"), "same input must always produce the same sid");
  assert.ok(a.startsWith(PRINCIPAL_SID_PREFIX), "must fall in the reserved namespace");
  assert.notEqual(a, sidForPrincipal("xyz-123"), "distinct principals must not collide");
  assert.equal(sidForPrincipal("abc-def"), "ii:abc-def", "must match backend/src/ws.mo's own derivation exactly");
});
