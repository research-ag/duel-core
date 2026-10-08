/// RacingRules — the turn-based racing game, as a pure `#simultaneous`
/// module. #p1/#p2 are the two cars on `Track`'s starting grid.
///
/// Rules: each round ("step") both players submit the ARC to drive — `l`
/// (distance, world units, negative = reverse) and `c` (curvature, 1 /
/// turn radius), the same units the frontend's `StepTrajectoryModel`
/// computes. `validate` recomputes the reachable arc from the car's speed
/// and fixed characteristics and rejects anything outside it. `resolve`
/// walks the arc against the track boundary exactly as the frontend's
/// `findTrajectoryCollisionWithMap` does, clamping the car to the edge
/// (speed 0) on a collision; a forward/neutral collision (`l >= 0`) arms a
/// 2-step recovery penalty forcing `{ l = 0; c = 0 }`. Progress is the
/// projection onto `Track.roadPath`, with a lap-percent wrap from >75% to
/// <25% counting one lap. First car past `LAPS_TO_WIN` wins; a
/// simultaneous finish is broken by total distance, an exact tie draws.
/// One track and one car, both baked-in constants.

import TP "mo:duel-game-core";
import Track "Track";
import Float "mo:core/Float";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import List "mo:core/List";
import Text "mo:core/Text";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: Racing
MODE: simultaneous
SEATS: p1 and p2 are the two cars on the starting grid
VARIANTS: none (the table variant text is ignored)

STATE (Candid)
  type Vec2 = record { float64; float64 };
  type CarState = record {
    position : Vec2;
    rotation : float64;
    speed : float64;
    lap : nat;
    distanceFromStart : float64;
    crashPenaltyRemaining : nat;
  };
  type State = record { p1 : CarState; p2 : CarState; step : nat };
  position: world units (x, y). rotation: heading in radians. speed:
  world units per step, never negative. lap: crossings of the road
  path's wrap point; the grid sits just before it, so the first
  crossing is free. distanceFromStart: arc length along the road path
  to the point nearest the car. crashPenaltyRemaining: steps still
  forced to a full stop. step: rounds resolved so far.

ACTION (Candid)
  type Action = record { l : float64; c : float64 };
  The arc to drive this step. l: distance in world units, negative =
  reverse. c: curvature = 1 / turn radius, sign = side, 0 = straight.

TRACK
  GET /track on this canister answers the geometry as plain text: three
  sections headed outerPolygon, innerPolygon and roadPath, one point
  per line as x y. A point is on the track when it is inside
  outerPolygon and outside innerPolygon (even-odd rule). roadPath is
  the closed centerline used to measure progress.

RULES
  Each step both seats submit an arc. From a car at position P with
  heading R, the arc (l, c) ends at local point
    c = 0:  (l, 0)
    else:   (sin(l*c) / c, (1 - cos(l*c)) / c)
  rotated by R and added to P, with new heading R + l*c.
  New speed: 0 when l < 0, else speed + 2 * (l - speed).
  The reachable arc at speed v:
    accel = (22500 - 0.4257*v^2 - 12.8*v) / 1350
    decel = min(v, (35000 + 0.4257*v^2 + 12.8*v) / 1350)
    maxDistance = v + accel / 2
    minDistance = max(0, v - decel / 2)
    when v < 0.25: minDistance = -maxDistance + v   (reversing allowed)
    maxCurvature = 1 / (5.5 + v^2 / 23)
  Rejected: l outside [minDistance, maxDistance], |c| > maxCurvature,
  or anything but l = 0, c = 0 while crashPenaltyRemaining > 0.
  The arc is sampled at ceil(|l| * 2) points. At the first sample off
  the track the car stops at the boundary with speed 0; when l >= 0
  this also sets crashPenaltyRemaining to 2.
  lap goes up by 1 when lap progress (distanceFromStart as a percentage
  of the road path length) wraps from above 75 to below 25, and down by
  1 (never below 0) on the opposite wrap.

ENDINGS
  A car finishes once its lap exceeds 1, that is after one full lap.
  One car finished: it wins. Both in the same step: more total progress
  (lap * road length + distanceFromStart) wins; an exact tie is a draw.

CLIENT NOTES
  Compute the reachable arc with the formulas above to offer only legal
  inputs. Both cars move in the same step; nothing is hidden once a
  step resolves.
";

  public type Vec2 = Track.Vec2;

  /// `l` = distance (negative = reverse), `c` = curvature (sign = side).
  public type Action = {
    l : Float;
    c : Float;
  };

  public type CarState = {
    position : Vec2;
    rotation : Float; // radians
    speed : Float; // world units per step; always >= 0
    lap : Nat; // wrap-boundary crossings (see `resolve`)
    distanceFromStart : Float; // progress along Track.roadPath this lap pass
    crashPenaltyRemaining : Nat; // steps still forced to { l = 0; c = 0 }
  };

  public type State = {
    p1 : CarState;
    p2 : CarState;
    step : Nat;
  };

  let LAPS_TO_WIN : Nat = 1;

  // The one car (the frontend's "Lambo Aventador" CAR constant in
  // lobby-connection.service.ts). Keep EXACTLY in sync: both sides
  // recompute the identical arc from these numbers.
  let STEERING_FACTOR : Float = 23.0;
  let DRAG_CONSTANT : Float = 0.4257;
  let WHEEL_FRICTION_CONSTANT : Float = 12.8;
  let ENGINE_FORCE : Float = 22500.0;
  let BRAKING_FORCE : Float = 35000.0;
  let MASS : Float = 1350.0;
  let DORMANT_TURN_RADIUS : Float = 5.5;

  // Guards accumulated rounding only; both sides compute the same doubles.
  let EPS : Float = 1e-6;

  func dist(a : Vec2, b : Vec2) : Float {
    Float.sqrt((a.0 - b.0) ** 2.0 + (a.1 - b.1) ** 2.0);
  };

  func rotate(p : Vec2, angle : Float) : Vec2 {
    (
      p.0 * Float.cos(angle) - p.1 * Float.sin(angle),
      p.1 * Float.cos(angle) + p.0 * Float.sin(angle),
    );
  };

  // Local-frame position after arc (l, c) — StepTrajectoryModel.position.
  func trajectoryPosition(l : Float, c : Float) : Vec2 {
    if (c == 0.0) {
      (l, 0.0);
    } else {
      (Float.sin(l * c) / c, (1.0 - Float.cos(l * c)) / c);
    };
  };

  func pointerRotation(l : Float, c : Float) : Float = l * c;

  // Sample count along arc (l, c) — the frontend's `Math.ceil(|l| * 2)`.
  func segCountFor(l : Float) : Nat {
    if (l == 0.0) return 1;
    Float.ceil(Float.abs(l) * 2.0).toInt().toNat();
  };

  // Even-odd ray casting (PNPOLY), as the frontend's `point-in-polygon`.
  func isInsidePolygon(p : Vec2, poly : [Vec2]) : Bool {
    let n = poly.size();
    var inside = false;
    var j : Nat = n - 1;
    for (i in Nat.range(0, n)) {
      let (xi, yi) = poly[i];
      let (xj, yj) = poly[j];
      if (((yi > p.1) != (yj > p.1)) and (p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi)) {
        inside := not inside;
      };
      j := i;
    };
    inside;
  };

  func isOnTrack(p : Vec2) : Bool {
    isInsidePolygon(p, Track.outerPolygon) and not isInsidePolygon(p, Track.innerPolygon);
  };

  // Bisects p1→p2 to the boundary crossing within 5cm —
  // MapPolygonModel.getLinePolygonIntersection.
  func trackBoundaryCrossing(p1 : Vec2, p2 : Vec2) : Vec2 {
    var innerPoint = if (isOnTrack(p1)) p1 else p2;
    var outerPoint = if (innerPoint.0 == p1.0 and innerPoint.1 == p1.1) p2 else p1;
    while (dist(innerPoint, outerPoint) > 0.05) {
      let mid = ((innerPoint.0 + outerPoint.0) / 2.0, (innerPoint.1 + outerPoint.1) / 2.0);
      if (isOnTrack(mid)) { innerPoint := mid } else { outerPoint := mid };
    };
    ((innerPoint.0 + outerPoint.0) / 2.0, (innerPoint.1 + outerPoint.1) / 2.0);
  };

  // findTrajectoryCollisionWithMap, collapsed to the arc's end state.
  func findCollision(basisPos : Vec2, basisRot : Float, l : Float, c : Float) : ?{
    pos : Vec2;
    rot : Float;
  } {
    let segsCount = segCountFor(l);
    let step = l / segsCount.toFloat();
    var prevWorld = basisPos;
    var i = 1;
    while (i <= segsCount) {
      let local = trajectoryPosition(i.toFloat() * step, c);
      let rotated = rotate(local, basisRot);
      let world = (rotated.0 + basisPos.0, rotated.1 + basisPos.1);
      if (not isOnTrack(world)) {
        let collisionPoint = trackBoundaryCrossing(prevWorld, world);
        let edgeDistance = Float.min(0.1, dist(basisPos, collisionPoint));
        let fixAngle = Float.arctan2(basisPos.1 - collisionPoint.1, basisPos.0 - collisionPoint.0);
        let pos = (
          collisionPoint.0 + Float.cos(fixAngle) * edgeDistance,
          collisionPoint.1 + Float.sin(fixAngle) * edgeDistance,
        );
        let rot = if (dist(basisPos, pos) > 0.01) {
          basisRot + i.toFloat() * (pointerRotation(l, c) / segsCount.toFloat());
        } else {
          basisRot;
        };
        return ?{ pos; rot };
      };
      prevWorld := world;
      i += 1;
    };
    null;
  };

  // Module-level bindings must be static, so road length and progress are
  // recomputed per call: one O(n) pass over 874 points, trivial next to
  // the collision check.

  // MapRoadSplineModel.roadLength.
  func roadLength() : Float {
    let pts = Track.roadPath;
    let n = pts.size();
    var total : Float = 0.0;
    for (i in Nat.range(0, n)) {
      total += dist(pts[i], pts[(i + 1) % n]);
    };
    total;
  };

  // Arc length from roadPath[0] to the nearest point on the centerline —
  // MapRoadSplineModel.getLapProgress, as a full scan (once per step).
  func distanceFromStartAt(p : Vec2) : Float {
    let pts = Track.roadPath;
    let n = pts.size();
    var cumulative : Float = 0.0;
    var bestDist : Float = -1.0;
    var best : Float = 0.0;
    for (i in Nat.range(0, n)) {
      let a = pts[i];
      let b = pts[(i + 1) % n];
      let ab = (b.0 - a.0, b.1 - a.1);
      let abLenSq = ab.0 * ab.0 + ab.1 * ab.1;
      let t0 = if (abLenSq == 0.0) 0.0 else ((p.0 - a.0) * ab.0 + (p.1 - a.1) * ab.1) / abLenSq;
      let t = Float.max(0.0, Float.min(1.0, t0));
      let closest = (a.0 + ab.0 * t, a.1 + ab.1 * t);
      let d = dist(p, closest);
      if (bestDist < 0.0 or d < bestDist) {
        bestDist := d;
        best := cumulative + dist(a, closest);
      };
      cumulative += dist(a, b);
    };
    best;
  };

  func lapPercentOf(d : Float) : Float = 100.0 * d / roadLength();

  func distanceInUAM(v0 : Float, a : Float, t : Float) : Float = t * (v0 + a * t / 2.0);
  func speedInUAM(v0 : Float, a : Float, t : Float) : Float = v0 + a * t;

  func maxAcceleration(speed : Float) : Float {
    (ENGINE_FORCE - DRAG_CONSTANT * speed ** 2.0 - WHEEL_FRICTION_CONSTANT * Float.abs(speed)) / MASS;
  };

  func maxDeceleration(speed : Float) : Float {
    // never backwards in one step: max deceleration == full stop
    let decelerationToFullStop = speed;
    Float.min(
      decelerationToFullStop,
      (BRAKING_FORCE + DRAG_CONSTANT * speed ** 2.0 + WHEEL_FRICTION_CONSTANT * Float.abs(speed)) / MASS,
    );
  };

  func steeringMaxCurvature(speed : Float) : Float {
    1.0 / (DORMANT_TURN_RADIUS + speed ** 2.0 / STEERING_FACTOR);
  };

  /// The reachable arc at `speed` — GamePhysicsService.getNextStepArea.
  /// Public so a client or test autopilot can preview what's legal.
  public func nextStepArea(speed : Float) : {
    minDistance : Float;
    maxDistance : Float;
    maxSteeringCurvature : Float;
  } {
    let maxDistance = distanceInUAM(speed, maxAcceleration(speed), 1.0);
    var minDistance = Float.max(0.0, distanceInUAM(speed, -maxDeceleration(speed), 1.0));
    if (Float.abs(speed) < 0.25) {
      // (nearly) stationary — allow reversing
      minDistance := -maxDistance + Float.abs(speed);
    };
    {
      minDistance;
      maxDistance;
      maxSteeringCurvature = steeringMaxCurvature(speed);
    };
  };

  func freshCar(position : Vec2, rotation : Float) : CarState = {
    position;
    rotation;
    speed = 0.0;
    lap = 0;
    distanceFromStart = distanceFromStartAt(position);
    crashPenaltyRemaining = 0;
  };

  public func init(_variant : Text) : State = {
    p1 = freshCar(Track.startP1Position, Track.startP1Rotation);
    p2 = freshCar(Track.startP2Position, Track.startP2Rotation);
    step = 0;
  };

  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    let me = switch (seat) { case (#p1) s.p1; case (#p2) s.p2 };
    if (me.crashPenaltyRemaining > 0) {
      if (a.l != 0.0 or a.c != 0.0) {
        return ?"Recovering from a crash — this step is forced to a full stop.";
      };
      return null;
    };
    let area = nextStepArea(me.speed);
    if (a.l < area.minDistance - EPS or a.l > area.maxDistance + EPS) {
      return ?"Requested distance is outside the car's reachable range this step.";
    };
    if (Float.abs(a.c) > area.maxSteeringCurvature + EPS) {
      return ?"Requested curvature exceeds the car's maximum steering this step.";
    };
    null;
  };

  func stepCar(car : CarState, a : Action) : CarState {
    let wasInPenalty = car.crashPenaltyRemaining > 0;
    let (pos, rot, speed, crashed) = switch (findCollision(car.position, car.rotation, a.l, a.c)) {
      case (?col) (col.pos, col.rot, 0.0, true);
      case null {
        let localEnd = trajectoryPosition(a.l, a.c);
        let worldEnd = rotate(localEnd, car.rotation);
        let newPos = (worldEnd.0 + car.position.0, worldEnd.1 + car.position.1);
        let newRot = car.rotation + pointerRotation(a.l, a.c);
        let newSpeed = if (a.l < 0.0) 0.0 else speedInUAM(car.speed, 2.0 * (a.l - car.speed), 1.0);
        (newPos, newRot, newSpeed, false);
      };
    };

    // A reverse move is clamped but never penalized.
    let penaltyTriggering = crashed and a.l >= 0.0 and not wasInPenalty;
    let crashPenaltyRemaining : Nat = if (wasInPenalty) {
      car.crashPenaltyRemaining - 1;
    } else if (penaltyTriggering) 2 else 0;

    let newDistanceFromStart = distanceFromStartAt(pos);
    let prevPercent = lapPercentOf(car.distanceFromStart);
    let newPercent = lapPercentOf(newDistanceFromStart);
    var lap = car.lap;
    if (prevPercent > 75.0 and newPercent < 25.0) {
      lap += 1;
    } else if (prevPercent < 25.0 and newPercent > 75.0 and lap > 0) {
      lap -= 1;
    };

    {
      position = pos;
      rotation = rot;
      speed;
      lap;
      distanceFromStart = newDistanceFromStart;
      crashPenaltyRemaining;
    };
  };

  func totalProgress(car : CarState) : Float {
    car.lap.toFloat() * roadLength() + car.distanceFromStart;
  };

  public func resolve(s : State, a1 : Action, a2 : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let p1 = stepCar(s.p1, a1);
    let p2 = stepCar(s.p2, a2);
    // The grid sits just before roadPath's wrap point, so the first move
    // crosses it once for free (lap 0 -> 1); finishing LAPS_TO_WIN real
    // laps takes LAPS_TO_WIN + 1 crossings — `>`, not `>=`. The frontend's
    // own lap tracking applies the same +1.
    let finished1 = p1.lap > LAPS_TO_WIN;
    let finished2 = p2.lap > LAPS_TO_WIN;
    let verdict : ?TP.Verdict = if (finished1 and finished2) {
      let t1 = totalProgress(p1);
      let t2 = totalProgress(p2);
      if (t1 > t2) ?#p1Wins else if (t2 > t1) ?#p2Wins else ?#draw;
    } else if (finished1) ?#p1Wins else if (finished2) ?#p2Wins else null;
    { state = { p1; p2; step = s.step + 1 }; verdict };
  };

  /// Served at `/track`: the geometry `SEMANTICS` refers to.
  public func trackText() : Text {
    let lines = List.empty<Text>();
    func section(name : Text, points : [Vec2]) {
      lines.add(name);
      for ((x, y) in points.values()) {
        lines.add(x.format(#fix 4) # " " # y.format(#fix 4));
      };
    };
    section("outerPolygon", Track.outerPolygon);
    section("innerPolygon", Track.innerPolygon);
    section("roadPath", Track.roadPath);
    Text.join(lines.values(), "\n");
  };

  public func spec() : TP.Spec<State, Action> = #simultaneous {
    init;
    validate;
    resolve;
  };
};
