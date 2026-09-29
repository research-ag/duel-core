// GamePlugin for the racing duel. The race itself renders in main.ts's
// full-viewport canvas (`body.in-race`); this only fills the compact HUD
// strip. Candid shapes mirror ../../../src/RacingRules.mo; `LAPS_TO_WIN`
// and `ONE_HOUR_MS` must match that module's and Host.mo's constants.

import { esc } from 'duel-game-core/render.js';

// `lap` counts wrap crossings; the first move crosses once for free, so
// finishing takes LAPS_TO_WIN + 1 (see RacingRules.mo's `resolve`).
const LAPS_TO_WIN = 1n;
const FINISH_LAP_COUNT = LAPS_TO_WIN + 1n;

const SEAT_NAME = { p1: 'Car 1', p2: 'Car 2' };

const ONE_HOUR_MS = 3_600_000n;

function lapsText(car) {
  const realLaps = car.lap > 0n ? car.lap - 1n : 0n;
  const laps = realLaps > LAPS_TO_WIN ? LAPS_TO_WIN : realLaps;
  return `${laps}/${LAPS_TO_WIN} laps`;
}

export const plugin = {
  idlTypes({ IDL }) {
    const Vec2 = IDL.Tuple(IDL.Float64, IDL.Float64);
    const CarState = IDL.Record({
      position: Vec2,
      rotation: IDL.Float64,
      speed: IDL.Float64,
      lap: IDL.Nat,
      distanceFromStart: IDL.Float64,
      crashPenaltyRemaining: IDL.Nat,
    });
    const State = IDL.Record({
      p1: CarState,
      p2: CarState,
      step: IDL.Nat,
    });
    const Action = IDL.Record({
      l: IDL.Float64,
      c: IDL.Float64,
    });
    return { Action, State };
  },

  seatLabel(seat) {
    return SEAT_NAME[seat];
  },

  // Inverts Host.mo's `scoreFromLapMs`. `0n` is the inert default score a
  // never-raced bot reports via `list_bots()`.
  formatScore(score) {
    if (score === 0n) return '--:--.--';
    const ms = ONE_HOUR_MS - score;
    const totalSeconds = Number(ms) / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(3).padStart(6, '0');
    return `${minutes}:${seconds}`;
  },

  renderBoard(gameState, mySeat, oppSeat) {
    const finished = gameState.p1.lap >= FINISH_LAP_COUNT || gameState.p2.lap >= FINISH_LAP_COUNT;
    if (finished) {
      return `
        <p>${esc(SEAT_NAME[mySeat])}: ${lapsText(gameState[mySeat])}</p>
        <p>${esc(SEAT_NAME[oppSeat])}: ${lapsText(gameState[oppSeat])}</p>`;
    }
    return `<p class="muted">${lapsText(gameState[mySeat])} — drive using the arc in front of your car.</p>`;
  },

  // Driving happens by clicking inside the 3D canvas.
  renderActions() {
    return '';
  },
};
