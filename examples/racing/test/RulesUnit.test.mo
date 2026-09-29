// Unit checks for the pure racing rules that Rules.test.mo misses:
// nextStepArea's shape, the reverse-never-crashes carve-out, the lap-
// decrement guard, and validate() from synthetic states.
import R "../src/RacingRules";
import Float "mo:core/Float";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let PI : Float = 3.14159265358979323846;
let STILL : R.Action = { l = 0.0; c = 0.0 };

// Same spot on Track.roadPath's wrap segment Rules.test.mo uses
func nearFinish() : R.CarState = {
  position = (101.5761, -19.8641);
  rotation = 1.4090;
  speed = 0.0;
  lap = 1;
  distanceFromStart = 1976.72;
  crashPenaltyRemaining = 0;
};
func idleCar() : R.CarState = { nearFinish() with lap = 0 };

// ── 1. spec() hands out the same rules as calling the module directly ──────
let sp = switch (R.spec()) {
  case (#simultaneous s) s;
  case (#alternating _) Runtime.trap("racing is a #simultaneous game");
};
let s1 = sp.init("");
assert s1.p1.lap == 0 and s1.p2.lap == 0;
switch (sp.validate(s1, #p1, { l = 999.0; c = 0.0 })) {
  case (?_) {};
  case null Runtime.trap("spec.validate must be the module's validate");
};
switch (sp.resolve(s1, STILL, STILL).verdict) {
  case null {};
  case (?_) Runtime.trap("sitting still resolves nothing");
};
Debug.print("1. spec() wiring OK");

// ── 2. nextStepArea: resting allows reverse; moving does not ───────────────
let atRest = R.nextStepArea(0.0);
assert atRest.minDistance < 0.0; // "back draft" — may reverse from a stop
assert atRest.maxDistance > 0.0;
let moving = R.nextStepArea(20.0);
assert moving.minDistance >= 0.0; // already rolling — no reverse this step
assert moving.maxDistance > atRest.maxDistance; // more momentum, more reach
assert moving.maxSteeringCurvature < atRest.maxSteeringCurvature; // harder to turn fast
Debug.print("2. nextStepArea shape OK");

// ── 3. A reverse move can still collide, but never arms the penalty ────────
// A car sitting right at the boundary, facing AWAY from the track (so
// reversing drives it back into the very wall a forward move would hit).
let atWall : R.CarState = {
  position = (105.0773, 44.6172);
  rotation = 1.4901 + PI;
  speed = 0.0;
  lap = 0;
  distanceFromStart = 500.0;
  crashPenaltyRemaining = 0;
};
let wallState : R.State = { p1 = atWall; p2 = idleCar(); step = 4 };
switch (R.validate(wallState, #p1, { l = -7.0; c = 0.0 })) {
  case (?msg) Runtime.trap("a reverse move within the backdraft range must be legal: " # msg);
  case null {};
};
let reversed = R.resolve(wallState, { l = -7.0; c = 0.0 }, STILL);
// it actually hit the wall (clamped near the start point, not the full 7
// units traveled) — this is a real collision, not a no-op check.
let (rx, ry) = reversed.state.p1.position;
let traveled = Float.sqrt((rx - atWall.position.0) ** 2.0 + (ry - atWall.position.1) ** 2.0);
assert traveled < 1.0;
assert reversed.state.p1.crashPenaltyRemaining == 0;
Debug.print("3. reverse collides without arming the crash penalty OK");

// ── 4. Lap can decrement if legitimately driven backward, never below 0 ────
func justPastLine(lap : Nat) : R.State = {
  p1 = {
    position = (102.3816, -14.9294);
    rotation = 1.4090;
    speed = 0.0;
    lap;
    distanceFromStart = 0.9457;
    crashPenaltyRemaining = 0;
  };
  p2 = idleCar();
  step = 41;
};
let backward : R.Action = { l = -5.0; c = 0.0 };
let fromOne = R.resolve(justPastLine(1), backward, STILL);
assert fromOne.state.p1.lap == 0;
let fromZero = R.resolve(justPastLine(0), backward, STILL);
assert fromZero.state.p1.lap == 0; // guarded — never negative
Debug.print("4. lap decrement + zero floor OK");

// ── 5. validate on a mid-recovery car rejects everything but a full stop ───
let recovering : R.CarState = { nearFinish() with crashPenaltyRemaining = 2 };
let recoveringState : R.State = { p1 = recovering; p2 = idleCar(); step = 10 };
switch (R.validate(recoveringState, #p1, { l = 0.1; c = 0.0 })) {
  case (?_) {};
  case null Runtime.trap("any nonzero move mid-recovery must be illegal");
};
switch (R.validate(recoveringState, #p1, { l = 0.0; c = 0.05 })) {
  case (?_) {};
  case null Runtime.trap("curvature alone mid-recovery must also be illegal");
};
switch (R.validate(recoveringState, #p1, STILL)) {
  case null {};
  case (?_) Runtime.trap("a full stop is always legal mid-recovery");
};
Debug.print("5. mid-recovery validate OK");

Debug.print("ALL RULES UNIT CHECKS PASSED");
