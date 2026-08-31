// Bridge to the actor `duel-app.js` (loaded as a plain script alongside
// this app's own esbuild bundle — see index.html) builds once at page
// load. That module owns agent/actor construction (see its own comments
// for why); this app just needs the same actor instance so both halves
// of the page talk to the same session. `index.html` sets
// `window.duelActorReady` up as a Promise before either script runs, so
// load order never matters.

declare global {
  interface Window {
    duelActorReady?: Promise<unknown>;
  }
}

export async function getDuelActor(): Promise<any> {
  if (!window.duelActorReady) {
    throw new Error('window.duelActorReady is missing — check index.html\'s inline bootstrap script');
  }
  return window.duelActorReady;
}

// Session identity is per-tab (sessionStorage), owned by duel-app.js's
// call to duel-game-core's start() — see its own comments. This app just
// reads the same key.
export function getSid(): string {
  return sessionStorage.getItem('sid') || '';
}
