// GamePlugin for the racing duel — the only game-specific piece
// duel-game-core's generic chrome (lobby, staging, rematch, debrief,
// session identity, push — see duel-app.js) needs. It does NOT render
// the actual race: that's the app's own esbuild bundle (main.ts) loaded
// alongside this page, which shares duel-app.js's own push poller (see
// ../app/modules/gameplay/game-communication/services/lobby-connection.service.ts)
// and takes over the full viewport (CSS class `body.in-race`, added by
// that service) once a game is under way — see style.scss.
//
// The `Action`/`State` Candid shapes here must mirror
// `../../../src/RacingRules.mo` exactly, and this plugin's own
// `LAPS_TO_WIN` must match that module's constant of the same name.

import { esc } from './node_modules/duel-game-core/dist/render.js';

// The raw `lap` field (below) counts wrap-boundary crossings of the track,
// not real laps driven — the starting grid sits right before the track's
// own wrap point, so a race's very first move already crosses it once
// "for free" (lap 0 -> 1) before anyone has driven anywhere near an actual
// lap. Finishing LAPS_TO_WIN real laps therefore takes LAPS_TO_WIN + 1 raw
// crossings — see RacingRules.mo's `resolve` comment, which this whole
// file must stay in sync with (both the LAPS_TO_WIN value and this +1).
const LAPS_TO_WIN = 1n;
const FINISH_LAP_COUNT = LAPS_TO_WIN + 1n;

const SEAT_NAME = { p1: 'Car 1', p2: 'Car 2' };

function lapsText(car) {
  // real laps completed, not raw crossings — subtract the free first
  // crossing so this doesn't jump straight to "1/1 laps" after one move.
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

  // The live race itself renders in the full-viewport 3D canvas main.ts
  // owns (see the module comment above) — this only needs to fill
  // duel-game-core's compact in-game HUD strip with something useful.
  // A finished race (both cars already past the finish line) instead gets
  // a plain text summary; the 3D view doesn't animate a frozen debrief.
  renderBoard(gameState, mySeat, oppSeat) {
    const finished = gameState.p1.lap >= FINISH_LAP_COUNT || gameState.p2.lap >= FINISH_LAP_COUNT;
    if (finished) {
      return `
        <p>${esc(SEAT_NAME[mySeat])}: ${lapsText(gameState[mySeat])}</p>
        <p>${esc(SEAT_NAME[oppSeat])}: ${lapsText(gameState[oppSeat])}</p>`;
    }
    return `<p class="muted">${lapsText(gameState[mySeat])} — drive using the arc in front of your car.</p>`;
  },

  // No buttons: driving happens by clicking inside the 3D canvas, not
  // through duel-game-core's generic data-act button delegation.
  renderActions() {
    return '';
  },
};
