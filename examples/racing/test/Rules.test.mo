// Scenario walk of the headline racing rules.
import R "../src/RacingRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

// A car one small step from the finish line, on lap 1
func nearFinish() : R.CarState = {
  position = (101.5761, -19.8641);
  rotation = 1.4090;
  speed = 0.0;
  lap = 1;
  distanceFromStart = 1976.72;
  crashPenaltyRemaining = 0;
};

// A car parked at the same spot as `nearFinish`, but on lap 0 — consistent
// (position matches distanceFromStart) so it never spuriously wraps a lap
// while it just sits still (STILL) waiting out the other seat's finish.
func idleCar() : R.CarState = { nearFinish() with lap = 0 };

let STILL : R.Action = { l = 0.0; c = 0.0 };

// ── 1. init() starts both cars at rest, on the grid, lap 0 ─────────────────
let s0 = R.init("");
assert s0.p1.speed == 0.0 and s0.p1.lap == 0 and s0.p1.crashPenaltyRemaining == 0;
assert s0.p2.speed == 0.0 and s0.p2.lap == 0 and s0.p2.crashPenaltyRemaining == 0;
assert s0.p1.position != s0.p2.position; // distinct starting slots
Debug.print("1. init() grid OK");

// ── 2. A legal forward move is accepted and makes real progress ────────────
let area0 = R.nextStepArea(s0.p1.speed);
let firstMove : R.Action = { l = area0.maxDistance; c = 0.0 };
switch (R.validate(s0, #p1, firstMove)) {
  case (?msg) Runtime.trap("a move within bounds must be legal: " # msg);
  case null {};
};
let afterFirst = R.resolve(s0, firstMove, STILL);
assert afterFirst.state.p1.speed > 0.0;
assert afterFirst.state.p1.distanceFromStart != s0.p1.distanceFromStart;
Debug.print("2. legal forward move OK");

// ── 3. A move outside the reachable arc is rejected on both axes ───────────
switch (R.validate(s0, #p1, { l = 100.0; c = 0.0 })) {
  case (?_) {};
  case null Runtime.trap("a wildly-too-far distance must be illegal");
};
switch (R.validate(s0, #p1, { l = 1.0; c = 1.0 })) {
  case (?_) {};
  case null Runtime.trap("a wildly-too-sharp curvature must be illegal");
};
Debug.print("3. out-of-envelope moves rejected OK");

// ── 4. Driving straight off the grid crashes; a 2-step penalty follows ─────
var s = s0;
var round = 0;
var crashed = false;
label driveLoop while (round < 10 and not crashed) {
  round += 1;
  let area = R.nextStepArea(s.p1.speed);
  let r = R.resolve(s, { l = area.maxDistance; c = 0.0 }, STILL);
  s := r.state;
  if (s.p1.crashPenaltyRemaining > 0) { crashed := true };
};
if (not crashed) Runtime.trap("driving straight off the grid should crash within a few steps");
assert s.p1.crashPenaltyRemaining == 2;
switch (R.validate(s, #p1, { l = 1.0; c = 0.0 })) {
  case (?_) {};
  case null Runtime.trap("mid-recovery, only a full stop should be legal");
};
switch (R.validate(s, #p1, STILL)) {
  case null {};
  case (?_) Runtime.trap("a full stop must be legal mid-recovery");
};
s := R.resolve(s, STILL, STILL).state;
assert s.p1.crashPenaltyRemaining == 1;
s := R.resolve(s, STILL, STILL).state;
assert s.p1.crashPenaltyRemaining == 0;
switch (R.validate(s, #p1, { l = 1.0; c = 0.0 })) {
  case null {};
  case (?_) Runtime.trap("control should be back after the 2-step penalty");
};
Debug.print("4. crash → 2-step recovery penalty OK");

// ── 5. Completing the lap wins ─────────────────────────────────────────────
let winState : R.State = { p1 = nearFinish(); p2 = idleCar(); step = 40 };
let win = R.resolve(winState, { l = 5.0; c = 0.0 }, STILL);
switch (win.verdict) {
  case (?#p1Wins) {};
  case (_) Runtime.trap("crossing the line for the 2nd time (1 real lap) must win");
};
assert win.state.p1.lap == 2;
Debug.print("5. lap finish wins OK");

// ── 6. Both cars finish the same step: further past the line wins ──────────
let photoFinish : R.State = { p1 = nearFinish(); p2 = nearFinish(); step = 40 };
let closeRace = R.resolve(photoFinish, { l = 5.0; c = 0.0 }, { l = 6.0; c = 0.0 });
switch (closeRace.verdict) {
  case (?#p2Wins) {};
  case (_) Runtime.trap("the car further past the line should take the photo finish");
};
let deadHeat = R.resolve(photoFinish, { l = 5.0; c = 0.0 }, { l = 5.0; c = 0.0 });
switch (deadHeat.verdict) {
  case (?#draw) {};
  case (_) Runtime.trap("an exact tie must draw");
};
Debug.print("6. simultaneous finish tie-break OK");

Debug.print("ALL RULES CHECKS PASSED");
