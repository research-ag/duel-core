// Anonymous but non-spoofable identity: a keypair generated once per
// browser and persisted in `localStorage`, so a link opened in a new tab
// plays as the same player. `regenerate` gives one tab a keypair of its own
// in `sessionStorage` (a second player for testing), which that tab keeps
// across reloads. Depends on `@icp-sdk/core/identity` only — a login-free
// game imports just this.

import type { Identity } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Principal } from "@icp-sdk/core/principal";

/// Must equal `Transport.ANON_SID_PREFIX`.
export const ANON_SID_PREFIX = "an:";

export function sidFor(prefix: string, principalText: string): string {
  return prefix + principalText;
}

const ANON_IDENTITY_STORAGE_KEY = "anon-identity";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/// `null` where the storage is missing or blocked (a sandboxed frame, a
/// browser refusing site data): the keypair then lasts until the page closes.
function storeOf(name: "localStorage" | "sessionStorage"): Store | null {
  try {
    return ((globalThis as Record<string, unknown>)[name] as Store | undefined) ?? null;
  } catch {
    return null;
  }
}

function load(store: Store | null): Ed25519KeyIdentity | null {
  try {
    const stored = store?.getItem(ANON_IDENTITY_STORAGE_KEY);
    return stored ? Ed25519KeyIdentity.fromParsedJson(JSON.parse(stored)) : null;
  } catch {
    return null; // corrupt or foreign — mint a fresh one
  }
}

function save(store: Store | null, identity: Ed25519KeyIdentity): boolean {
  try {
    if (store === null) return false;
    store.setItem(ANON_IDENTITY_STORAGE_KEY, JSON.stringify(identity.toJSON()));
    return true;
  } catch {
    return false;
  }
}

/// This tab's own keypair first, else the browser's, else a new browser one.
function loadOrCreateAnonIdentity(): Ed25519KeyIdentity {
  const tab = load(storeOf("sessionStorage"));
  if (tab) return tab;
  const browser = storeOf("localStorage");
  const existing = load(browser);
  if (existing) return existing;
  const identity = Ed25519KeyIdentity.generate();
  save(browser, identity);
  return identity;
}

export interface ResolvedAnonymousIdentity {
  /// Builds the agent; its principal is the player.
  identity: Identity;
  principal: Principal;
  sid: string;
}

/// Reuses the persisted keypair (one per browser, unless this tab has its
/// own) or generates one. Call once, early.
export function resolveAnonymousIdentity(): ResolvedAnonymousIdentity {
  const identity = loadOrCreateAnonIdentity();
  const principal = identity.getPrincipal();
  return { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
}

/// Gives this tab a fresh keypair of its own; other tabs keep theirs. The
/// caller still reloads for it to take effect. Throws where the browser
/// keeps no session storage for the page: a reload would bring the old
/// player back.
export function regenerateAnonymousIdentity(): ResolvedAnonymousIdentity {
  if (!save(storeOf("sessionStorage"), Ed25519KeyIdentity.generate())) {
    throw new Error("this browser keeps no data for this page, so this tab cannot have a player of its own");
  }
  return resolveAnonymousIdentity();
}
