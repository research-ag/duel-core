// Player identity: an active Internet Identity login, or the persisted
// anonymous keypair from ./anon-identity.ts. Depends on `@icp-sdk/auth`
// on top of what anon-identity.ts needs; a login-free game imports only
// that file. See ../README.md, "Logging in with Internet Identity".

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import { ANON_SID_PREFIX, regenerateAnonymousIdentity, resolveAnonymousIdentity, sidFor } from "./anon-identity.js";

export { ANON_SID_PREFIX, sidFor };

/// Must equal `Transport.PRINCIPAL_SID_PREFIX`; the backend enforces it.
export const PRINCIPAL_SID_PREFIX = "ii:";

export function sidForPrincipal(principalText: string): string {
  return sidFor(PRINCIPAL_SID_PREFIX, principalText);
}

export interface ResolveIdentityOptions {
  /// Overrides `@icp-sdk/auth`'s default identity provider.
  identityProvider?: string | URL;
}

export interface ResolvedIdentity {
  /// For `HttpAgent.create({ identity, host })`.
  identity: Identity;
  /// The principal `identity` signs as.
  principal: Principal;
  /// For `start({ session, ... })`.
  sid: string;
  isLoggedIn: boolean;
  /// Opens the login flow, then reloads (nothing rebuilds actor/transport in
  /// place). Rejects without reloading if the flow fails.
  login(opts?: { maxTimeToLive?: bigint; targets?: Principal[] }): Promise<void>;
  /// Signs out, then reloads.
  logout(opts?: { returnTo?: string }): Promise<void>;
  /// Discards the anonymous keypair, then reloads. No-op when logged in.
  regenerate(): Promise<void>;
}

/// Call once, early, before building the agent/actor/transport.
export async function resolveIdentity(opts?: ResolveIdentityOptions): Promise<ResolvedIdentity> {
  const authClient = new AuthClient(
    opts?.identityProvider !== undefined ? { identityProvider: opts.identityProvider } : undefined,
  );
  const isLoggedIn = authClient.isAuthenticated();
  const identity = isLoggedIn ? await authClient.getIdentity() : resolveAnonymousIdentity().identity;
  const principal = identity.getPrincipal();
  const sid = isLoggedIn ? sidForPrincipal(principal.toText()) : sidFor(ANON_SID_PREFIX, principal.toText());

  return {
    identity,
    principal,
    sid,
    isLoggedIn,
    async login(loginOpts) {
      await authClient.signIn(loginOpts);
      location.reload();
    },
    async logout(logoutOpts) {
      await authClient.signOut(logoutOpts);
      location.reload();
    },
    async regenerate() {
      if (isLoggedIn) return;
      regenerateAnonymousIdentity();
      location.reload();
    },
  };
}
