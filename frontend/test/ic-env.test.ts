import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// ic-env.ts reads `document.cookie`/`window.location` at call time (not
// module-load time), so stubbing these globals before each call is
// enough — no need for a real DOM. Deleted again in afterEach so a
// stubbed `document`/`window` never leaks into another test file if
// node:test ever runs this process without per-file isolation.

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

function withCookie<T>(cookie: string, fn: () => T): T {
  (globalThis as unknown as { document: { cookie: string } }).document = { cookie };
  return fn();
}

function withLocation<T>(location: { protocol: string; hostname: string; port: string }, fn: () => T): T {
  (globalThis as unknown as { window: { location: typeof location } }).window = { location };
  return fn();
}

test("readIcEnv: no cookie at all returns {}", async () => {
  const { readIcEnv } = await import("../src/ic-env.js");
  assert.deepEqual(withCookie("other=1", () => readIcEnv()), {});
});

test("readIcEnv: decodes the ic_env cookie into a plain object", async () => {
  const { readIcEnv } = await import("../src/ic-env.js");
  const cookie = "foo=bar; ic_env=" + encodeURIComponent("PUBLIC_CANISTER_ID:backend=abc123&ic_root_key=deadbeef");
  assert.deepEqual(withCookie(cookie, () => readIcEnv()), {
    "PUBLIC_CANISTER_ID:backend": "abc123",
    ic_root_key: "deadbeef",
  });
});

test("deriveHost: localhost keeps the port, drops any subdomain", async () => {
  const { deriveHost } = await import("../src/ic-env.js");
  assert.equal(
    withLocation({ protocol: "http:", hostname: "abc123.localhost", port: "8000" }, () => deriveHost()),
    "http://localhost:8000",
  );
});

test("deriveHost: icp0.io / ic0.app strip the canister subdomain, keep the parent", async () => {
  const { deriveHost } = await import("../src/ic-env.js");
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.icp0.io", port: "" }, () => deriveHost()),
    "https://icp0.io",
  );
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.ic0.app", port: "" }, () => deriveHost()),
    "https://ic0.app",
  );
});

test("deriveHost: anything else falls back to the dedicated API gateway, not icp0.io", async () => {
  const { deriveHost } = await import("../src/ic-env.js");
  // icp0.io/ic0.app only reliably send CORS headers for their OWN
  // registered subdomains — a custom domain (icp-cli's *.icp.net here,
  // but the same applies to any project's own domain) needs icp-api.io,
  // the API-only boundary host built to accept cross-origin calls from
  // any origin. A hardcoded icp0.io fallback is exactly the bug the 007
  // defect report's finding 03 reproduced: every call refused by CORS.
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.icp.net", port: "" }, () => deriveHost()),
    "https://icp-api.io",
  );
  assert.equal(
    withLocation({ protocol: "https:", hostname: "example.com", port: "" }, () => deriveHost()),
    "https://icp-api.io",
  );
});
