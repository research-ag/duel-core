import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  fetchGameModule,
  rawWasm,
  readModuleHash,
  MODULE_STORE,
  type Download,
  type Downloaded,
} from "../src/module-store.js";

const CID = "ghjib-pyaaa-aaaac-bga5a-cai";
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 7, 7, 7]);
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/// A download answering from a table of URLs, recording every URL asked.
function fakeDownload(routes: Record<string, Downloaded>): Download & { asked: string[] } {
  const asked: string[] = [];
  const d = (async (url: string) => {
    asked.push(url);
    return routes[url] ?? { status: 404, bytes: new Uint8Array(), contentEncoding: null };
  }) as Download & { asked: string[] };
  d.asked = asked;
  return d;
}

const ok = (bytes: Uint8Array, contentEncoding: string | null = null): Downloaded => ({
  status: 200,
  bytes,
  contentEncoding,
});

test("match: store bytes whose SHA-256 is the live module hash are returned", async () => {
  const hash = hex(WASM);
  const download = fakeDownload({ [`${MODULE_STORE}/${hash}`]: ok(WASM) });
  const m = await fetchGameModule(CID, { readModuleHash: async () => hash, download });
  assert.deepEqual(m, { hash, bytes: WASM, gzipped: false });
  assert.deepEqual(download.asked, [`${MODULE_STORE}/${hash}`]);
});

test("hash mismatch: store bytes that hash differently are rejected", async () => {
  const hash = hex(WASM);
  const tampered = new Uint8Array([...WASM, 0]);
  const download = fakeDownload({ [`${MODULE_STORE}/${hash}`]: ok(tampered) });
  await assert.rejects(
    fetchGameModule(CID, { readModuleHash: async () => hash, download }),
    /body hashes to/,
  );
});

test("404: a module missing from the store is an error", async () => {
  const hash = hex(WASM);
  const download = fakeDownload({});
  await assert.rejects(
    fetchGameModule(CID, { readModuleHash: async () => hash, download }),
    /module store has no/,
  );
  assert.deepEqual(download.asked, [`${MODULE_STORE}/${hash}`]);
});

test("gzipped body: hashed as stored, reported gzipped, gunzipped on demand", async () => {
  const gz = new Uint8Array(gzipSync(WASM));
  const hash = hex(gz);
  const download = fakeDownload({ [`${MODULE_STORE}/${hash}`]: ok(gz, "gzip") });
  const m = await fetchGameModule(CID, { readModuleHash: async () => hash, download });
  assert.equal(m.gzipped, true);
  assert.deepEqual(m.bytes, gz);
  assert.deepEqual(await rawWasm(m), WASM);
});

test("gzipped body decompressed in transit fails the hash check", async () => {
  const hash = hex(new Uint8Array(gzipSync(WASM)));
  const download = fakeDownload({ [`${MODULE_STORE}/${hash}`]: ok(WASM, "gzip") });
  await assert.rejects(
    fetchGameModule(CID, { readModuleHash: async () => hash, download }),
    /decompressed in transit/,
  );
});

test("a canister with no module is an error before any download", async () => {
  const download = fakeDownload({});
  await assert.rejects(
    fetchGameModule(CID, { readModuleHash: async () => null, download }),
    /no module installed/,
  );
  assert.equal(download.asked.length, 0);
});

test("readModuleHash reads canister/<id>/module_hash through readState, as hex", async () => {
  let asked: unknown;
  const agent = {
    readState: async (target: unknown, opts: { paths: unknown[] }) => {
      asked = { target, n: opts.paths.length };
      return { values: { get: () => new Uint8Array([0xab, 0x01]) } };
    },
  } as unknown as Parameters<typeof readModuleHash>[1];
  assert.equal(await readModuleHash(CID, agent), "ab01");
  assert.equal((asked as { n: number }).n, 1);
  assert.equal(
    ((asked as { target: { canisterId: { toText(): string } } }).target.canisterId).toText(),
    CID,
  );
  const empty = { readState: async () => ({ values: { get: () => null } }) } as unknown as Parameters<
    typeof readModuleHash
  >[1];
  assert.equal(await readModuleHash(CID, empty), null);
});
