// Anonymous, but non-spoofable, player identity: a keypair this tab
// generates once and persists in `sessionStorage` (so it survives a
// reload of THIS tab, but a second tab — and a fresh identity for anyone
// else — is automatically independent, same as the plain per-tab `sid`
// this replaces always was), rather than the caller-chosen freeform text
// a previous version of this module used. `../backend/src/ws.mo`'s
// `onMessage` guard is the sole enforcement — this file computes a `sid`
// consistent with it, but a request is only ever actually accepted
// because the WS connection itself is authenticated as the exact same
// principal (see `resolveAnonymousIdentity`'s own doc).
//
// This is the ONE place in the package that depends on
// `@icp-sdk/core/identity` for real keypair generation (`identity.ts`
// depends on it too, but only indirectly, by re-exporting from here) —
// deliberately kept separate from `identity.ts` itself, which additionally
// depends on `@icp-sdk/auth` for real Internet Identity login: a game
// that wants a real, non-spoofable identity with NO login step at all
// imports only this file and pulls in neither `@icp-sdk/auth` nor its own
// transitive dependencies; a game that also wants a login option imports
// `identity.js` instead (which re-exports everything here). Every other
// file in this package (`app.js`, `render.js`, `idl.js`, `ic-env.js`)
// stays fully dependency-free — see the root `CLAUDE.md`'s rule 10.

import type { Identity } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Principal } from "@icp-sdk/core/principal";

/// Reserved `SessionId` namespace for an anonymous, locally generated
/// keypair — MUST compute the exact same value as `backend/src/ws.mo`'s
/// own `Ws.ANON_SID_PREFIX`, which is what actually enforces this
/// binding (rejects any request whose claimed `sid` falls in this
/// namespace but doesn't match the caller's own authenticated
/// principal). This file computes the identical value but enforces
/// nothing itself — the backend is the sole source of truth.
export const ANON_SID_PREFIX = "an:";

/// The permanent player id for principal `p` under the given reserved
/// prefix (given as text — callers already have a `Principal` object at
/// the point they'd call this, `principal.toText()` is one extra call
/// away). Pure and deterministic: an id is "issued" for free the moment
/// a principal is first seen, and can never change for as long as the
/// same keypair/login keeps resolving to the same principal. Shared by
/// both reserved namespaces — `identity.ts`'s `sidForPrincipal` is a
/// thin wrapper calling this with `PRINCIPAL_SID_PREFIX`.
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
      // Corrupt/foreign value (or a leftover from a format this version
      // no longer understands) — fall through and mint a fresh one below
      // rather than throwing during page load.
    }
  }
  const identity = Ed25519KeyIdentity.generate();
  sessionStorage.setItem(ANON_IDENTITY_STORAGE_KEY, JSON.stringify(identity.toJSON()));
  return identity;
}

export interface ResolvedAnonymousIdentity {
  /// Hand this to `HttpAgent.create({ identity, host })` — this exact
  /// identity, not a fresh or different one, must also be what opens the
  /// WS connection (`connectWs({ principal, ... })`), since `sid`'s
  /// non-spoofability comes entirely from the backend checking it against
  /// the connection's own authenticated principal.
  identity: Identity;
  /// The same identity's own principal — hand this to `connectWs({ principal, ... })`.
  principal: Principal;
  /// This tab's player id — hand this to `start({ session, ... })`.
  sid: string;
}

/// Resolves this tab's anonymous identity: reuses the keypair already
/// persisted in `sessionStorage` if present (so `sid` — and the WS
/// connection's own authenticated principal — survive a reload of this
/// tab unchanged), otherwise generates and persists a fresh one. A
/// second tab is automatically a second player, exactly as the plain,
/// caller-chosen `sid` this replaces always was — `sessionStorage` is
/// per-tab. Call this once, early, before building the agent/actor/ws.
export function resolveAnonymousIdentity(): ResolvedAnonymousIdentity {
  const identity = loadOrCreateAnonIdentity();
  const principal = identity.getPrincipal();
  return { identity, principal, sid: sidFor(ANON_SID_PREFIX, principal.toText()) };
}

/// Discards this tab's persisted anonymous keypair and mints a fresh one
/// — what `start()`'s "new sid"/"play as someone else" button does. The
/// caller still needs to rebuild its agent/actor/ws and reload for the
/// new identity to actually take effect (see `ResolvedIdentity.regenerate`
/// in `identity.ts`, which does exactly that) — this function only
/// updates storage.
export function regenerateAnonymousIdentity(): ResolvedAnonymousIdentity {
  sessionStorage.removeItem(ANON_IDENTITY_STORAGE_KEY);
  return resolveAnonymousIdentity();
}
