import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// ic-env.ts reads `document.cookie`/`window.location` at call time (not
// module-load time), so stubbing these globals before each call is enough

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
  // The bare parent domain IS the boundary-node API host for these two, so
  // stripping the canister-id subdomain is what keeps the call same-site.
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.icp0.io", port: "" }, () => deriveHost()),
    "https://icp0.io",
  );
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.ic0.app", port: "" }, () => deriveHost()),
    "https://ic0.app",
  );
});

test("deriveHost: icp.net keeps the page's own origin unchanged, does NOT strip to the parent", async () => {
  const { deriveHost } = await import("../src/ic-env.js");
  // Unlike icp0.io/ic0.app, the bare parent domain (`icp.net`) is icp-cli's
  // own marketing/dashboard host, not an API endpoint
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.icp.net", port: "" }, () => deriveHost()),
    "https://abc123.icp.net",
  );
  assert.equal(
    withLocation({ protocol: "https:", hostname: "abc123.icp.net", port: "8080" }, () => deriveHost()),
    "https://abc123.icp.net:8080",
  );
});

test("deriveHost: anything unrecognized falls back to the dedicated API gateway", async () => {
  const { deriveHost } = await import("../src/ic-env.js");
  assert.equal(
    withLocation({ protocol: "https:", hostname: "example.com", port: "" }, () => deriveHost()),
    "https://icp-api.io",
  );
});
