// Player identity: which principal this tab is signed in as, and which
// `sid` (the engine's own player id — see app.ts's file header) that
// resolves to. Every player — anonymous or logged in — gets a real,
// non-spoofable identity by default; see `../backend/README.md`'s
// "Player identity" section for the backend half of this design.
//
// This file additionally depends on `@icp-sdk/auth` (Internet Identity's
// `AuthClient`) on top of what `./anon-identity.js` already needs — a
// second documented, narrow dependency exception alongside
// `ws/gateway-*.ts` (see the root `CLAUDE.md`'s rule 10). A game that
// wants a real identity with no login step at all can import only
// `duel-game-core/anon-identity.js` instead and avoid this file (and
// `@icp-sdk/auth`) entirely; every other file in this package (`app.js`,
// `render.js`, `idl.js`, `ic-env.js`) stays fully dependency-free either
// way.
//
// `start()` requires a `session` — one call replaces hand-rolling
// `AuthClient` wiring, persisted-keypair generation, and id derivation
// yourself:
//
//   import { resolveIdentity } from "duel-game-core/identity.js";
//   const session = await resolveIdentity();
//   const agent = await HttpAgent.create({ host, identity: session.identity });
//   const actor = Actor.createActor(idlFactory, { agent, canisterId });
//   const ws = connectWs({ actor, principal: session.principal, gameIdlTypes });
//   start({ plugin, ws, session });
//
// See `../README.md`'s "Logging in with Internet Identity" section for
// the full worked example, including the login/logout button.

import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import { ANON_SID_PREFIX, regenerateAnonymousIdentity, resolveAnonymousIdentity, sidFor } from "./anon-identity.js";

export { ANON_SID_PREFIX, sidFor };

/// Reserved `SessionId` namespace for a real, permanent Internet Identity
/// login — MUST compute the exact same value as `backend/src/ws.mo`'s own
/// `Ws.PRINCIPAL_SID_PREFIX`, which is what actually enforces this
/// binding (rejects any request whose claimed `sid` falls in this
/// namespace but doesn't match the caller's own authenticated
/// principal). This file computes the identical value but enforces
/// nothing itself — the backend is the sole source of truth.
export const PRINCIPAL_SID_PREFIX = "ii:";

/// The permanent player id for a principal, given as text. Pure and
/// deterministic: a logged-in player's id is "issued" for free at their
/// first login and can never change for as long as the same login keeps
/// resolving to the same principal.
export function sidForPrincipal(principalText: string): string {
  return sidFor(PRINCIPAL_SID_PREFIX, principalText);
}

export interface ResolveIdentityOptions {
  /// Passed straight through to `new AuthClient(...)` when set — overrides
  /// `@icp-sdk/auth`'s own default identity provider. Leave unset unless a
  /// deployment genuinely needs a non-default one; the default already
  /// works from any origin, including a local dev server.
  identityProvider?: string | URL;
}

export interface ResolvedIdentity {
  /// Hand this to `HttpAgent.create({ identity, host })`.
  identity: Identity;
  /// The same identity's own principal — hand this to `connectWs({ principal, ... })`.
  principal: Principal;
  /// This tab's player id — hand this to `start({ session, ... })`.
  sid: string;
  /// Whether `identity`/`sid` came from a real Internet Identity login
  /// (permanent, principal-backed, stable across devices) rather than a
  /// locally generated, persisted-per-tab anonymous keypair (also
  /// principal-backed, just not permanent or portable).
  isLoggedIn: boolean;
  /// Opens the Internet Identity login flow; on success, reloads the page
  /// (there is no in-place actor/ws teardown-and-rebuild anywhere in this
  /// package — a reload is how a freshly authenticated identity always
  /// takes effect, same as `app.ts`'s own `showDisconnected()` recovery
  /// path). Rejects (without reloading) if the flow fails or is
  /// cancelled — let the caller's own error handling (e.g. `start()`'s
  /// `showError`) surface that.
  login(opts?: { maxTimeToLive?: bigint; targets?: Principal[] }): Promise<void>;
  /// Clears the Internet Identity session and reloads. A no-op-ish
  /// convenience for an anonymous session (nothing to sign out of) —
  /// still reloads, since that's also how `start()`'s "new sid" button
  /// resumes cleanly for a game that only shows this button once logged
  /// in.
  logout(opts?: { returnTo?: string }): Promise<void>;
  /// Discards this tab's persisted anonymous keypair, mints a fresh one,
  /// and reloads — what `start()`'s "new sid"/"play as someone else"
  /// button does. Reloads (rather than swapping `sid` in place) because
  /// the new identity needs its own freshly authenticated WS connection —
  /// `sid`'s non-spoofability depends on it matching the connection's own
  /// principal, so the two can no longer drift apart the way a plain
  /// client-asserted sid once could. A no-op for a logged-in session
  /// (nothing to regenerate; `start()` already hides this button once
  /// `isLoggedIn` is true).
  regenerate(): Promise<void>;
}

/// Resolves which identity this tab is acting as: a real, permanent
/// Internet Identity login if one's already active, otherwise this tab's
/// persisted anonymous keypair (see `./anon-identity.js`'s
/// `resolveAnonymousIdentity`) — either way, a real principal backs
/// `sid`, non-spoofable by construction rather than just a naming
/// convention (see `../backend/src/ws.mo`'s `isAuthorizedSid`). Call this
/// once, early, before building the agent/actor/ws.
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
