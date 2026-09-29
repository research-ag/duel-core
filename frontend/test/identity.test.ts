// Unit checks for identity.ts's own pure helpers.
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
