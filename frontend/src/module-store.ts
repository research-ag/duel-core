// The exact module a game canister runs, from hosty.live's public module
// store. The canister's `module_hash` is read from the IC state tree
// (certificate verified by the agent), the store is asked for that hash,
// and the bytes are accepted only if their SHA-256 equals it. See README,
// "Fetching a game's module". The store sends a gzipped module as
// `application/gzip`, never with a `Content-Encoding`, so the default
// download, `fetch`, keeps the bytes as stored for every module.
//
//   const { hash, bytes, gzipped } = await fetchGameModule("ghjib-...-cai");

import { HttpAgent, StatePaths } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

export const MODULE_STORE = "https://api.hosty.live/modules";
export const IC_HOST = "https://icp-api.io";

export interface GameModule {
  /// Hex SHA-256 of `bytes`, equal to the canister's live `module_hash`.
  hash: string;
  /// The module exactly as installed (gzipped when `gzipped`).
  bytes: Uint8Array;
  gzipped: boolean;
}

export interface Downloaded {
  status: number;
  bytes: Uint8Array;
  contentEncoding: string | null;
}

/// A GET whose `bytes` are the body exactly as sent.
export type Download = (url: string) => Promise<Downloaded>;

export interface FetchGameModuleOptions {
  /// Agent for the state-tree read; a mainnet one by default.
  agent?: HttpAgent;
  readModuleHash?: (canisterId: string) => Promise<string | null>;
  download?: Download;
}

/// `fetch`: the body as sent when it carries no `Content-Encoding`, which
/// the store never sets; a body decoded on the way fails the hash check.
export const fetchDownload: Download = async (url) => {
  const res = await fetch(url);
  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentEncoding: res.headers.get("content-encoding"),
  };
};

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
  );
}

export const isGzip = (b: Uint8Array): boolean =>
  b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/// The canister's live `module_hash` (hex), or `null` with no module
/// installed. `readState` verifies the certificate against the agent's
/// root key and the canister id before any value is read.
export async function readModuleHash(
  canisterId: string,
  agent?: Pick<HttpAgent, "readState">,
): Promise<string | null> {
  const id = Principal.fromText(canisterId);
  const a = agent ?? (await HttpAgent.create({ host: IC_HOST }));
  const path = StatePaths.canisterModuleHash(id);
  const { values } = await a.readState({ canisterId: id }, { paths: [path] });
  const hash = values.get(path);
  return hash ? toHex(hash) : null;
}

export async function moduleMeta(
  hash: string,
): Promise<{ hash: string; size: number; gzipped: boolean; verified: boolean; candid?: string } | null> {
  const res = await fetch(`${MODULE_STORE}/${hash}/meta`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`module store: meta ${hash} answered ${res.status}`);
  return res.json();
}

/// Asks hosty.live to re-read `canisterId`'s module hash and keep the
/// stored module (unverified ones are deleted after 24 hours).
export async function requestVerification(hash: string, canisterId: string): Promise<boolean> {
  const res = await fetch(`${MODULE_STORE}/${hash}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canisterId }),
  });
  return res.ok;
}

async function checked(hash: string, got: Downloaded): Promise<GameModule> {
  const actual = await sha256Hex(got.bytes);
  if (actual !== hash) {
    // The store sends a gzipped module as stored; a proxy may still decode it.
    const hint = isGzip(got.bytes)
      ? ""
      : " (if it was decompressed in transit, pass a `download` that keeps the body as sent)";
    throw new Error(`module ${hash}: body hashes to ${actual}${hint}`);
  }
  return { hash, bytes: got.bytes, gzipped: isGzip(got.bytes) };
}

export async function fetchGameModule(
  canisterId: string,
  opts: FetchGameModuleOptions = {},
): Promise<GameModule> {
  const download = opts.download ?? fetchDownload;
  const hash = await (opts.readModuleHash ?? ((id) => readModuleHash(id, opts.agent)))(canisterId);
  if (!hash) throw new Error(`${canisterId} has no module installed`);
  const got = await download(`${MODULE_STORE}/${hash}`);
  if (got.status === 404) throw new Error(`module store has no ${hash} (${canisterId})`);
  if (got.status !== 200) throw new Error(`module store: ${hash} answered ${got.status}`);
  return checked(hash, got);
}

/// The plain wasm of a module, gunzipped when it is stored gzipped.
export async function rawWasm(m: GameModule): Promise<Uint8Array> {
  if (!m.gzipped) return m.bytes;
  const stream = new Blob([m.bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
