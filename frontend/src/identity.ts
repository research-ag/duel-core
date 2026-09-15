// Player identity: which principal (if any) this tab is signed in as, and
// which `sid` (the engine's own player id — see app.ts's file header)
// that resolves to. This is the ONE place in the package that depends on
// `@icp-sdk/auth` (Internet Identity's `AuthClient`) and on
// `@icp-sdk/core/identity` — a second documented, narrow dependency
// exception alongside `ws/gateway-*.ts` (see the root `CLAUDE.md`'s rule
// 10): every other file here (`app.ts`, `render.ts`, `idl.ts`,
// `ic-env.ts`) stays dependency-free.
//
// A game that doesn't care about login can ignore this file entirely —
// `start()` still self-generates a plain, anonymous per-tab `sid` exactly
// as it always has (see app.ts) when no `session` option is passed. This
// module exists so a game that DOES want real, permanent, non-spoofable
// player identity doesn't have to hand-roll `AuthClient` wiring, a
// throwaway-identity fallback, and id derivation itself — one
// `resolveIdentity()` call replaces all three:
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
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Principal } from "@icp-sdk/core/principal";

/// Reserved `SessionId` namespace for a principal-backed identity — MUST
/// compute the exact same value as `backend/src/ws.mo`'s own
/// `sidForPrincipal`/`PRINCIPAL_SID_PREFIX`, which is what actually
/// enforces this binding (rejects any request whose claimed `sid` falls
/// in this namespace but doesn't match the caller's own authenticated
/// principal). This file computes the identical value but enforces
/// nothing itself — the backend is the sole source of truth.
export const PRINCIPAL_SID_PREFIX = "ii:";

/// The permanent player id for a principal, given as text (`Principal
/// .toText()` — callers already have a `Principal` object at the point
/// they'd call this, `principal.toText()` is one extra call away). Pure
/// and deterministic: a logged-in player's id is "issued" for free at
/// their first login and can never change for as long as the same login
/// keeps resolving to the same principal.
export function sidForPrincipal(principalText: string): string {
  return PRINCIPAL_SID_PREFIX + principalText;
}

const SID_STORAGE_KEY = "sid";

function randomSid(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/// This tab's own anonymous player id: a `?sid=` URL override wins (and
/// is remembered), otherwise whatever's already in `sessionStorage`,
/// otherwise a fresh random one — sessionStorage is per-tab, so a second
/// tab is automatically a second player. The exact mechanism `start()`
/// always used before this module existed; kept here (not app.ts) so
/// `resolveIdentity()`'s anonymous branch and `start()`'s own "new sid"
/// button both go through the one copy of it.
///
/// A stored value inside the reserved `PRINCIPAL_SID_PREFIX` ("ii:")
/// namespace is never adopted here even if present — it's a leftover
/// from a login `start()` wrote into `sessionStorage` (see `app.ts`),
/// and only the matching principal may legitimately claim it (see
/// `isAuthorizedSid` on the backend); reusing it for a fresh anonymous
/// identity gets that sid rejected as belonging to someone else.
export function resolveAnonymousSid(): string {
  const urlSid = new URLSearchParams(location.search).get(SID_STORAGE_KEY);
  if (urlSid) sessionStorage.setItem(SID_STORAGE_KEY, urlSid);
  const stored = sessionStorage.getItem(SID_STORAGE_KEY);
  if (!stored || stored.startsWith(PRINCIPAL_SID_PREFIX)) {
    sessionStorage.setItem(SID_STORAGE_KEY, randomSid());
  }
  return sessionStorage.getItem(SID_STORAGE_KEY) as string;
}

/// Discards this tab's own anonymous sid and picks a fresh random one —
/// what `start()`'s "new sid"/"play as someone else" button does.
export function regenerateAnonymousSid(): string {
  const sid = randomSid();
  sessionStorage.setItem(SID_STORAGE_KEY, sid);
  return sid;
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
  /// This tab's player id — hand this to `start({ session, ... })` (or use
  /// it directly as `sid` with a hand-rolled `ws`/`start` caller).
  sid: string;
  /// Whether `identity`/`sid` came from a real Internet Identity login
  /// (permanent, principal-backed) rather than a fresh, throwaway,
  /// anonymous identity generated for this page load.
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
  /// still reloads, since that's also how "new sid" behavior resumes
  /// cleanly for a game that only shows this button once logged in.
  logout(opts?: { returnTo?: string }): Promise<void>;
}

/// Resolves which identity this tab is acting as: a real, permanent
/// Internet Identity login if one's already active, otherwise a fresh,
/// throwaway, non-anonymous identity (`Ed25519KeyIdentity.generate()`) —
/// deliberately not anonymous, since `ic-websocket-cdk`'s `ws_open` hard-
/// rejects the anonymous principal, and deliberately not derived from/
/// stable across `sid` either (see `../README.md`'s own doc on the real
/// `ic-websocket-cdk` bookkeeping bug a stable-per-reload throwaway
/// identity used to trigger). Call this once, early, before building the
/// agent/actor/ws.
export async function resolveIdentity(opts?: ResolveIdentityOptions): Promise<ResolvedIdentity> {
  const authClient = new AuthClient(
    opts?.identityProvider !== undefined ? { identityProvider: opts.identityProvider } : undefined,
  );
  const isLoggedIn = authClient.isAuthenticated();
  const identity = isLoggedIn ? await authClient.getIdentity() : Ed25519KeyIdentity.generate();
  const principal = identity.getPrincipal();
  const sid = isLoggedIn ? sidForPrincipal(principal.toText()) : resolveAnonymousSid();

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
  };
}
