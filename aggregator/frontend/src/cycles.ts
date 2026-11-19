// A backend's cycle balance and memory, read from the `cycles_balance`
// and `rts_memory_size` gauges promtracker serves at `/metrics`
// (anonymous query, nothing stored), kept in one page-wide store so a
// card, the info modal and the owner's summary all see the same number,
// and the same refresh after a top-up. Also the top-up links: CyclePay
// takes the canister and the amount in its URL; hosty.live's canister
// page has its own dialog.

import { useSyncExternalStore } from "react";

import { backendOf, fetchText, outOfCycles } from "./canisterHttp";
import type { GameView } from "./types";

export const TC = 1_000_000_000_000n;
const GIB = 1n << 30n;

/// Where a backend stops taking moves, estimated from its memory. Under
/// its freezing reserve (30 days of its idle burn by default, about
/// 0.93 TC per GiB of memory: 007 burns 7.74 B a day at 269 MB) the IC
/// refuses every call, reads included. Each message also pays for its
/// run in advance, about 0.17 TC more (executions stopped near 0.40 TC
/// at 256 MiB): between the two, reads work and every move is refused.
/// Both scale with the subnet's size and the reserve with the
/// canister's own setting, which nothing outside its controllers can
/// read, so this stays an estimate.
const RESERVE_PER_GIB = 926_000_000_000n;
const PREPAID = 170_000_000_000n;

export function stopPointOf(memory: bigint | undefined): bigint {
  return PREPAID + ((memory ?? 0n) * RESERVE_PER_GIB) / GIB;
}

/// Above the stop point by less than this, a backend is running low:
/// bots and the sweep timer, whose calls reserve more, fail first.
const LOW_MARGIN = 300_000_000_000n;

/// What `/metrics` reported.
export interface Balance {
  cycles: bigint;
  /// `undefined` when the backend serves no `rts_memory_size`.
  memory: bigint | undefined;
}

/// `undefined` while the first read runs, `null` when the canister
/// serves no `cycles_balance` or could not be reached, `"frozen"` when
/// the IC refused the read because the canister is under its freezing
/// reserve.
export type Reading = Balance | "frozen" | null | undefined;

export type Status = "healthy" | "low" | "down" | "frozen";

export function statusOf(reading: Reading): Status | undefined {
  if (reading == null) return undefined;
  if (reading === "frozen") return "frozen";
  const stop = stopPointOf(reading.memory);
  return reading.cycles < stop
    ? "down"
    : reading.cycles < stop + LOW_MARGIN
      ? "low"
      : "healthy";
}

export const STATUS_WORD: Record<Status, string> = {
  healthy: "Healthy",
  low: "Running low",
  down: "Likely down",
  frozen: "Frozen",
};

/// One sentence on what a reading means for the game.
export function statusNote(reading: Balance | "frozen"): string {
  if (reading === "frozen")
    return "Under its freezing reserve: it refuses every call, reads included, until it is topped up.";
  const stop = stopPointOf(reading.memory);
  const mib =
    reading.memory === undefined
      ? ""
      : ` for its ${Number(reading.memory / (1n << 20n))} MiB of memory`;
  return reading.cycles < stop
    ? `Moves are likely refused: under the ${formatTC(stop)} it needs${mib} (an estimate).`
    : `Moves stop at about ${formatTC(stop)}${mib} (an estimate).`;
}

export function cyclesOf(reading: Reading): bigint | undefined {
  return reading == null || reading === "frozen" ? undefined : reading.cycles;
}

export function formatTC(cycles: bigint): string {
  const tc = Number(cycles) / Number(TC);
  return `${tc >= 1 ? tc.toFixed(1) : tc.toFixed(2)} TC`;
}

/// `cycles` in TC with every significant decimal, for amounts typed in.
export function exactTC(cycles: bigint): string {
  const frac = (cycles % TC).toString().padStart(12, "0").replace(/0+$/, "");
  return `${cycles / TC}${frac ? `.${frac}` : ""} TC`;
}

/// A decimal amount of TC (up to 12 places, the cycle) in cycles.
export function parseTC(text: string): bigint | undefined {
  const m = /^\s*(\d*)(?:\.(\d{0,12}))?\s*$/.exec(text);
  if (!m || (m[1] === "" && !m[2])) return undefined;
  return BigInt(m[1] || "0") * TC + BigInt((m[2] ?? "").padEnd(12, "0"));
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

export const CYCLEPAY_MIN_USD = 1;
/// Below it, CyclePay's card checkout asks the payer to sign in.
export const CYCLEPAY_NO_SIGN_IN_USD = 5;
export const CYCLEPAY_MAX_USD = 100;

export function cyclePayUrl(canister: string, usd: number): string {
  return `https://www.cyclepay.org/c/${canister}/${usd}`;
}

/// Cycle Express's `to` parameter (read by its page, undocumented) opens
/// the payment step for that canister directly.
export function cycleExpressUrl(canister: string): string {
  return `https://cycle.express/?to=${canister}`;
}

export function hostyCanisterUrl(canister: string): string {
  return `https://hosty.live/panel/canister/${canister}`;
}

export interface CycleStore {
  /// Frontend id → its backend id: `undefined` while it is looked up,
  /// `null` when it publishes none.
  backends: ReadonlyMap<string, string | null | undefined>;
  /// Backend id → what its `/metrics` reported.
  readings: ReadonlyMap<string, Reading>;
}

const backends = new Map<string, string | null | undefined>();
const readings = new Map<string, Reading>();
let snapshot: CycleStore = { backends, readings };
const listeners = new Set<() => void>();

function changed() {
  snapshot = { backends: new Map(backends), readings: new Map(readings) };
  for (const l of listeners) l();
}

function gauge(metrics: string, name: string): bigint | undefined {
  const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\d+)`, "m").exec(metrics);
  return m ? BigInt(m[1]) : undefined;
}

const RETRY_DELAYS_MS = [1_000, 3_000];

/// `null` when the canister answers but serves no `cycles_balance`;
/// throws once every attempt failed to get an answer at all.
async function readBalance(backend: string): Promise<Balance | "frozen" | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await fetchText(backend, "/metrics");
      const cycles = text === undefined ? undefined : gauge(text, "cycles_balance");
      if (text === undefined || cycles === undefined) return null;
      return { cycles, memory: gauge(text, "rts_memory_size") };
    } catch (err) {
      if (outOfCycles(err)) return "frozen";
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/// Per backend, the number of the latest read started and of the read
/// whose answer is stored, so answers land in the order the reads were
/// started whatever order they arrive in.
const started = new Map<string, number>();
const stored = new Map<string, number>();

/// Re-reads one backend's balance (after a payment, say) and resolves
/// with what the store holds afterwards. An answer from a read older
/// than the stored one is dropped; a read that fails outright changes
/// nothing, except that the latest read failing with no answer stored
/// yet reads as `null`.
export async function refreshCycles(backend: string): Promise<Reading> {
  const mine = (started.get(backend) ?? 0) + 1;
  started.set(backend, mine);
  try {
    const value = await readBalance(backend);
    if (mine > (stored.get(backend) ?? 0)) {
      stored.set(backend, mine);
      readings.set(backend, value);
      changed();
    }
  } catch {
    if (started.get(backend) === mine && readings.get(backend) === undefined) {
      readings.set(backend, null);
      changed();
    }
  }
  return readings.get(backend);
}

/// Starts the lookups for a listing, once per page load: its backend,
/// then that backend's balance.
export function trackGame(game: GameView): void {
  const id = game.frontendCanisterId.toText();
  if (backends.has(id)) return;
  backends.set(id, undefined);
  void backendOf(game.frontendCanisterId).then((backend) => {
    backends.set(id, backend ?? null);
    if (!backend || readings.has(backend)) {
      changed();
      return;
    }
    readings.set(backend, undefined);
    changed();
    void refreshCycles(backend);
  });
}

/// Starts the balance read for a canister known by id (the dashboard's
/// own backend, a bot), once per page load.
export function trackBackend(backend: string): void {
  if (readings.has(backend)) return;
  readings.set(backend, undefined);
  changed();
  void refreshCycles(backend);
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

export function readingOfGame(store: CycleStore, game: GameView): Reading {
  const backend = store.backends.get(game.frontendCanisterId.toText());
  if (backend == null) return backend;
  return store.readings.get(backend);
}
