// A backend's cycle balance, read from the `cycles_balance` gauge that
// promtracker serves at `/metrics` (anonymous query, nothing stored),
// kept in one page-wide store so a card, the info modal and the
// owner's summary all see the same number — and the same refresh after
// a top-up. Also the top-up links: CyclePay takes the canister and the
// amount in its URL; hosty.live's canister page has its own dialog.

import { useSyncExternalStore } from "react";

import { backendOf, textOf } from "./canisterHttp";
import type { GameView } from "./types";

export const TC = 1_000_000_000_000n;

/// Bands on the backend balance. A hosty.live install needs 0.5 TC on
/// the canister, so a game under that cannot be reinstalled; under
/// 0.2 TC it is close to its freezing threshold.
export const HEALTHY_TC = 0.5;
export const LOW_TC = 0.2;

export type Band = "healthy" | "low" | "critical";

export function bandOf(cycles: bigint): Band {
  const tc = Number(cycles) / Number(TC);
  return tc >= HEALTHY_TC ? "healthy" : tc >= LOW_TC ? "low" : "critical";
}

export const BAND_WORD: Record<Band, string> = {
  healthy: "Healthy",
  low: "Running low",
  critical: "May stop soon",
};

export function formatTC(cycles: bigint): string {
  const tc = Number(cycles) / Number(TC);
  return `${tc >= 1 ? tc.toFixed(1) : tc.toFixed(2)} TC`;
}

/// Estimates only: CyclePay charges 1 XDR per TC plus Stripe's fee; the
/// XDR rate here is a constant at the time of writing. The checkout
/// page states the amount actually charged.
const XDR_USD = 1.33;
const STRIPE_PCT = 0.029;
const STRIPE_FIXED = 0.3;

export function tcForUsd(usd: number): number {
  return Math.max(0, (usd * (1 - STRIPE_PCT) - STRIPE_FIXED) / XDR_USD);
}

export const CYCLEPAY_MIN_USD = 5;
export const CYCLEPAY_MAX_USD = 100;

export function cyclePayUrl(canister: string, usd: number): string {
  return `https://www.cyclepay.org/c/${canister}/${usd}`;
}

export const CYCLE_EXPRESS_URL = "https://cycle.express/";

export function hostyCanisterUrl(canister: string): string {
  return `https://hosty.live/panel/canister/${canister}`;
}

/// `undefined` while a read runs, `null` when the canister serves no
/// `cycles_balance`.
export type Cycles = bigint | null | undefined;

export interface CycleStore {
  /// Frontend id → its backend id: `undefined` while it is looked up,
  /// `null` when it publishes none.
  backends: ReadonlyMap<string, string | null | undefined>;
  /// Backend id → balance.
  cycles: ReadonlyMap<string, Cycles>;
}

const backends = new Map<string, string | null | undefined>();
const cycles = new Map<string, Cycles>();
let snapshot: CycleStore = { backends, cycles };
const listeners = new Set<() => void>();

function changed() {
  snapshot = { backends: new Map(backends), cycles: new Map(cycles) };
  for (const l of listeners) l();
}

function parseCycles(metrics: string): bigint | undefined {
  const m = /^cycles_balance(?:\{[^}]*\})?\s+(\d+)/m.exec(metrics);
  return m ? BigInt(m[1]) : undefined;
}

async function readCycles(backend: string): Promise<Cycles> {
  const text = await textOf(backend, "/metrics");
  return (text === undefined ? undefined : parseCycles(text)) ?? null;
}

/// Re-reads one backend's balance (after a payment, say) and resolves
/// with the new value.
export async function refreshCycles(backend: string): Promise<Cycles> {
  const value = await readCycles(backend);
  cycles.set(backend, value);
  changed();
  return value;
}

/// Starts the lookups for a listing, once per page load: its backend,
/// then that backend's balance.
export function trackGame(game: GameView): void {
  const id = game.frontendCanisterId.toText();
  if (backends.has(id)) return;
  backends.set(id, undefined);
  void backendOf(game.frontendCanisterId).then((backend) => {
    backends.set(id, backend ?? null);
    if (!backend || cycles.has(backend)) {
      changed();
      return;
    }
    cycles.set(backend, undefined);
    changed();
    void refreshCycles(backend);
  });
}

export function useCycleStore(): CycleStore {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot
  );
}

export function cyclesOfGame(store: CycleStore, game: GameView): Cycles {
  const backend = store.backends.get(game.frontendCanisterId.toText());
  if (backend == null) return backend;
  return store.cycles.get(backend);
}
