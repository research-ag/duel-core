// Anonymous but non-spoofable identity: a keypair generated once per tab
// and persisted in `sessionStorage`. The backend's `isAuthorizedSid` is
// the sole enforcement; this file only computes a consistent `sid`. Depends
// on `@icp-sdk/core/identity` only — a login-free game imports just this.

import type { Identity } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Principal } from "@icp-sdk/core/principal";

/// Must equal `Transport.ANON_SID_PREFIX`.
export const ANON_SID_PREFIX = "an:";

export function sidFor(prefix: string, principalText: string): string {
  return prefix + principalText;
}

const ANON_IDENTITY_STORAGE_KEY = "anon-identity";

function loadOrCreateAnonIdentity(): Ed25519KeyIdentity {
  const stored = sessionStorage.getItem(ANON_IDENTITY_STORAGE_KEY);
  if (stored) {
    try {
      return Ed25519KeyIdentity.fromParsedJson(JSON.parse(stored));
    } catch {
      // corrupt or foreign — mint a fresh one
    }
  }
  const identity = Ed25519KeyIdentity.generate();
  sessionStorage.setItem(ANON_IDENTITY_STORAGE_KEY, JSON.stringify(identity.toJSON()));
  return identity;
}

export interface ResolvedAnonymousIdentity {
  /// Must also be the identity that opens the WS connection.
  identity: Identity;
  principal: Principal;
  sid: string;
}

/// Reuses the persisted keypair (so `sid` survives a reload of this tab;
/// a second tab is a second player) or generates one. Call once, early.
export function resolveAnonymousIdentity(): ResolvedAnonymousIdentity {
  const identity = loadOrCreateAnonIdentity();
  const principal = identity.getPrincipal();
  return { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
}

/// Discards the persisted keypair and mints a fresh one; the caller still
/// reloads for it to take effect.
export function regenerateAnonymousIdentity(): ResolvedAnonymousIdentity {
  sessionStorage.removeItem(ANON_IDENTITY_STORAGE_KEY);
  return resolveAnonymousIdentity();
}
