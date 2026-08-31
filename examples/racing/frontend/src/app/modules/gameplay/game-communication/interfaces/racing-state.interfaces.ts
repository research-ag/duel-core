// Mirrors RacingRules.mo's `CarState`/`State`/`Action` (../../../../../../../../src/RacingRules.mo)
// as decoded by @dfinity/candid — Nat fields decode to `bigint`, and a
// Motoko `(Float, Float)` tuple decodes to a 2-element `[number, number]`
// array. Keep in sync with the Candid shape in duel-racing-plugin.js's
// `idlTypes` (and, in turn, with RacingRules.mo itself).

export interface RacingCarState {
  position: [number, number];
  rotation: number;
  speed: number;
  lap: bigint;
  distanceFromStart: number;
  crashPenaltyRemaining: bigint;
}

export interface RacingState {
  p1: RacingCarState;
  p2: RacingCarState;
  step: bigint;
}

export interface RacingAction {
  l: number;
  c: number;
}
