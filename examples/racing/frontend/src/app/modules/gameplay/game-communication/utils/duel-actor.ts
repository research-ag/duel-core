// Bridge to the actor (and its push poller) `duel-app.js` (loaded as a
// plain script alongside this app's own esbuild bundle — see index.html)
// builds once at page load. That module owns agent/actor/ws construction
// (see its own comments for why); this app just needs the SAME instances
// so both halves of the page talk to the same session over the same
// poller, rather than each running their own. `index.html` sets
// `window.duelActorReady`/`duelWsReady` up as Promises before either
// script runs, so load order never matters. `getDuelActor()` is unused by
// this example's own gameplay code today — lobby-connection.service.ts
// only ever needs `getDuelWs()`, since every canister call it makes
// (submit, status) goes through the shared poller — kept here as the
// general-purpose escape hatch to the raw actor, should something ever
// need a canister method the poller doesn't cover.

declare global {
  interface Window {
    duelActorReady?: Promise<unknown>;
    duelWsReady?: Promise<unknown>;
  }
}

export async function getDuelActor(): Promise<any> {
  if (!window.duelActorReady) {
    throw new Error('window.duelActorReady is missing — check index.html\'s inline bootstrap script');
  }
  return window.duelActorReady;
}

// Resolves to the SAME `PollingWs` duel-app.js's generic chrome uses (see
// duel-game-core/ws/poller.js) — always present; there is no
// plain-polling fallback anywhere in duel-game-core any more.
export async function getDuelWs(): Promise<any> {
  if (!window.duelWsReady) {
    throw new Error('window.duelWsReady is missing — check index.html\'s inline bootstrap script');
  }
  return window.duelWsReady;
}

// Session identity is per-tab (sessionStorage), owned by duel-app.js's
// call to duel-game-core's start() — see its own comments. This app just
// reads the same key.
export function getSid(): string {
  return sessionStorage.getItem('sid') || '';
}
