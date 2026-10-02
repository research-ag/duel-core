// Bridge to the actor and `DuelTransport` duel-app.js builds, published via
// Promises index.html sets up before either script runs.

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

export async function getDuelWs(): Promise<any> {
  if (!window.duelWsReady) {
    throw new Error('window.duelWsReady is missing — check index.html\'s inline bootstrap script');
  }
  return window.duelWsReady;
}

// Written by duel-app.js's start().
export function getSid(): string {
  return sessionStorage.getItem('sid') || '';
}
