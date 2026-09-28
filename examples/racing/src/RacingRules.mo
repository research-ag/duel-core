/// ═══════════════════════════════════════════════════════════════════════════
/// RacingRules — the turn-based racing game logic, as a pure module.
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = { init; validate; resolve }
///
/// Seat mapping: #p1 / #p2 = the two cars on the starting grid (`Track`).
///
/// ── Rules ──────────────────────────────────────────────────────────────────
/// Each round ("step") both players submit the ARC they want to drive this
/// step — `l` (distance, world units, negative = reverse) and `c` (curvature,
/// 1 / turn radius). This mirrors exactly what the frontend already computes
/// client-side per step (`StepTrajectoryModel { l; c }`); the difference is
/// that the ENGINE, not the browser, is now the one deciding what happens:
///
///   - `validate` recomputes the car's reachable arc this step (min/max
///     distance from its current speed and the car's fixed acceleration /
///     braking / drag characteristics, max steering curvature from its
///     current speed) and rejects anything outside it — a client can no
///     longer request a faster car, tighter turn, or moved-while-crashed
///     step than physics allows, however its UI is wired.
///   - `resolve` walks the requested arc against the track boundary
///     (`Track.outerPolygon` minus `Track.innerPolygon`, both baked in from
///     the one map this example ships) exactly as the frontend's
///     `findTrajectoryCollisionWithMap` does, and clamps the car to the
///     boundary (speed reset to 0) if it would leave the drivable surface.
///     A forward/neutral collision (`l >= 0`) also arms a 2-step recovery
///     penalty: `validate` forces the next 2 submissions from that seat to
///     `{ l = 0; c = 0 }`. (The frontend additionally exempts 2 further
///     real moves from re-arming the penalty right after control resumes —
///     a per-frame edge case that doesn't apply here since a "step" IS a
///     round; deliberately not reproduced.)
///   - Progress is measured by projecting the car's position onto
///     `Track.roadPath` (the centerline) each step and tracking the
///     resulting lap-percent's wrap from >75% to <25% as one completed lap,
///     the same heuristic the frontend uses. First car to complete
///     `LAPS_TO_WIN` laps wins; if both cross the line in the same step,
///     whichever is further past it (by total distance travelled) wins —
///     an exact tie is vanishingly unlikely with floats, but resolves to a
///     draw.
///
/// This example supports exactly one track and one car, so both the track
/// geometry (`Track.mo`) and the car's characteristics (below) are baked-in
/// constants rather than configuration — a real multi-track or multi-car
/// game would thread both through `State`/`Spec` instead.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";
import Track "Track";
import Float "mo:core/Float";
import Nat "mo:core/Nat";
import Int "mo:core/Int";

module {

  // ────────────────────────── moves & state ──────────────────────────────────

  public type Vec2 = Track.Vec2;

  /// One car's requested arc for this step: `l` = distance (world units,
  /// negative = reverse), `c` = curvature (1 / turn radius; sign = side).
  public type Action = {
    l : Float;
    c : Float;
  };

  public type CarState = {
    position : Vec2;
    rotation : Float; // radians
    speed : Float; // world units per step; always >= 0
    lap : Nat; // completed laps
    distanceFromStart : Float; // progress along Track.roadPath this lap pass
    crashPenaltyRemaining : Nat; // steps still forced to { l = 0; c = 0 }
  };

  public type State = {
    p1 : CarState;
    p2 : CarState;
    step : Nat; // steps resolved so far
  };

  // ────────────────────────── tuning constants ───────────────────────────────

  let LAPS_TO_WIN : Nat = 1;

  // The one car this example ships (the frontend's "Lambo Aventador" CAR
  // constant — see frontend/src/app/modules/gameplay/game-communication/
  // services/lobby-connection.service.ts). Keep these EXACTLY in sync with
  // that constant: `validate` recomputes the reachable arc from these same
  // numbers, and the frontend independently recomputes the identical arc
  // (vehicle-physics.service.ts) to drive its own UI — any mismatch means
  // a move the client shows as legal gets rejected server-side, or vice
  // versa. Pumped up from a more sedate original tune (engine/braking/
  // steering only, not mass/drag/friction) so a race clears faster without
  // making the car physically implausible.
  let STEERING_FACTOR : Float = 23.0;
  let DRAG_CONSTANT : Float = 0.4257;
  let WHEEL_FRICTION_CONSTANT : Float = 12.8;
  let ENGINE_FORCE : Float = 22500.0;
  let BRAKING_FORCE : Float = 35000.0;
  let MASS : Float = 1350.0;
  let DORMANT_TURN_RADIUS : Float = 5.5;

  // Tolerance for the validate() bounds check — both sides compute the same
  // IEEE754-double formula from the same inputs, so this only guards against
  // accumulated rounding, not real out-of-range requests.
  let EPS : Float = 1e-6;

  // ────────────────────────── small geometry helpers ─────────────────────────

  func dist(a : Vec2, b : Vec2) : Float {
    Float.sqrt((a.0 - b.0) ** 2.0 + (a.1 - b.1) ** 2.0);
  };

  func rotate(p : Vec2, angle : Float) : Vec2 {
    (
      p.0 * Float.cos(angle) - p.1 * Float.sin(angle),
      p.1 * Float.cos(angle) + p.0 * Float.sin(angle),
    );
  };

  // Position (in the car's local frame, heading = +x) after driving arc
  // (l, c) — matches StepTrajectoryModel.position on the frontend.
  func trajectoryPosition(l : Float, c : Float) : Vec2 {
    if (c == 0.0) {
      (l, 0.0);
    } else {
      (Float.sin(l * c) / c, (1.0 - Float.cos(l * c)) / c);
    };
  };

  func pointerRotation(l : Float, c : Float) : Float = l * c;

  // Number of points breakToSegments() would sample along arc (l, c) —
  // matches the frontend's default `Math.ceil(Math.abs(l) * 2)`, floored to 1.
  func segCountFor(l : Float) : Nat {
    if (l == 0.0) return 1;
    Float.ceil(Float.abs(l) * 2.0).toInt().toNat();
  };

  // ────────────────────────── track boundary ──────────────────────────────────

  // Even-odd ray-casting point-in-polygon test (PNPOLY), same algorithm the
  // frontend's `point-in-polygon` npm dependency implements.
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

  // Bisects the segment p1→p2 (one endpoint on-track, one off) down to the
  // boundary crossing point, to within 5cm — matches
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

  // If driving arc (l, c) from (basisPos, basisRot) would leave the track,
  // returns the clamped (position, rotation) at the boundary — matches
  // findTrajectoryCollisionWithMap, collapsed to the arc's END state (the
  // engine has no per-frame animation to drive; it only needs where the car
  // ends up after the full step, which is always past the collision point
  // once one occurs).
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

  // ────────────────────────── road centerline / progress ─────────────────────

  // Module-level bindings must be static in Motoko (no function calls at
  // library top level), so — unlike everything else that's a one-time
  // baked-in constant — road length and distance-from-start are recomputed
  // on demand rather than memoized. Both are a single O(n) pass over
  // `Track.roadPath` (874 points): trivially cheap next to the boundary
  // collision check below, so this costs nothing worth caching.

  // Full loop length of the road centerline (closing segment back to point
  // 0 included) — matches MapRoadSplineModel.roadLength.
  func roadLength() : Float {
    let pts = Track.roadPath;
    let n = pts.size();
    var total : Float = 0.0;
    for (i in Nat.range(0, n)) {
      total += dist(pts[i], pts[(i + 1) % n]);
    };
    total;
  };

  // Full search over every road segment for the nearest point to `p`,
  // returning that point's arc length from roadPath[0] (i.e. cumulative
  // length of every segment strictly before the nearest one, plus the
  // partial distance into it) — matches MapRoadSplineModel.getLapProgress.
  // The frontend restricts this search to segments near the car's last
  // known position because it runs every animation frame (60 fps); the
  // engine only runs it once per step, so a full scan is simpler and just
  // as correct.
  func distanceFromStartAt(p : Vec2) : Float {
    let pts = Track.roadPath;
    let n = pts.size();
    var cumulative : Float = 0.0;
    var bestDist : Float = -1.0; // sentinel, replaced on first iteration
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

  // ────────────────────────── vehicle kinematics ──────────────────────────────

  func distanceInUAM(v0 : Float, a : Float, t : Float) : Float = t * (v0 + a * t / 2.0);
  func speedInUAM(v0 : Float, a : Float, t : Float) : Float = v0 + a * t;

  func maxAcceleration(speed : Float) : Float {
    (ENGINE_FORCE - DRAG_CONSTANT * speed ** 2.0 - WHEEL_FRICTION_CONSTANT * Float.abs(speed)) / MASS;
  };

  func maxDeceleration(speed : Float) : Float {
    // never allowed to go backwards in one step: max deceleration == full stop
    let decelerationToFullStop = speed;
    Float.min(
      decelerationToFullStop,
      (BRAKING_FORCE + DRAG_CONSTANT * speed ** 2.0 + WHEEL_FRICTION_CONSTANT * Float.abs(speed)) / MASS,
    );
  };

  func steeringMaxCurvature(speed : Float) : Float {
    1.0 / (DORMANT_TURN_RADIUS + speed ** 2.0 / STEERING_FACTOR);
  };

  // The reachable arc for a car currently at `speed` this step — matches
  // GamePhysicsService.getNextStepArea. Exposed publicly (not just used by
  // `validate`) so a client — or, here, the test suites' autopilot — can
  // preview what's legal before submitting, the same way the frontend's
  // `currentStepArcProperties` does.
  public func nextStepArea(speed : Float) : {
    minDistance : Float;
    maxDistance : Float;
    maxSteeringCurvature : Float;
  } {
    let maxDistance = distanceInUAM(speed, maxAcceleration(speed), 1.0);
    var minDistance = Float.max(0.0, distanceInUAM(speed, -maxDeceleration(speed), 1.0));
    if (Float.abs(speed) < 0.25) {
      // stationary (or nearly) — allow reversing ("back draft")
      minDistance := -maxDistance + Float.abs(speed);
    };
    {
      minDistance;
      maxDistance;
      maxSteeringCurvature = steeringMaxCurvature(speed);
    };
  };

  // ────────────────────────── Spec: init ──────────────────────────────────────

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

  // ────────────────────────── Spec: validate ──────────────────────────────────

  /// null = legal. The engine calls this for BOTH seats on every submission,
  /// so a client bypassing its own UI clamps still can't cheat: the arc must
  /// be within what the car's current speed and characteristics can reach,
  /// and a car mid-recovery from a crash must submit a full stop.
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

  // ────────────────────────── Spec: resolve ───────────────────────────────────

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

    // a reverse move is never treated as a crash for penalty purposes, even
    // though it's still physically clamped to the boundary above.
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

  /// Both moves are in (already validated). Pure: State in, State + verdict out.
  public func resolve(s : State, a1 : Action, a2 : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let p1 = stepCar(s.p1, a1);
    let p2 = stepCar(s.p2, a2);
    // `lap` counts wrap-boundary crossings, not real laps driven, and the
    // starting grid (Track.startP1Position/startP2Position) sits right
    // before Track.roadPath's own wrap point (same spot nearFinish() in
    // the test suites uses) - so the very first move of the race already
    // crosses it once (lap 0 -> 1) without having driven anywhere near an
    // actual lap. Every crossing AFTER that first free one is a real lap,
    // so finishing LAPS_TO_WIN real laps takes LAPS_TO_WIN + 1 raw
    // crossings - `>`, not `>=`. (The frontend's own lap-tracking
    // - gameplay.service.ts's LAPS_TO_WIN - has this exact same grid-offset
    // quirk and must apply the same +1.)
    let finished1 = p1.lap > LAPS_TO_WIN;
    let finished2 = p2.lap > LAPS_TO_WIN;
    let verdict : ?TP.Verdict = if (finished1 and finished2) {
      let t1 = totalProgress(p1);
      let t2 = totalProgress(p2);
      if (t1 > t2) ?#p1Wins else if (t2 > t1) ?#p2Wins else ?#draw;
    } else if (finished1) ?#p1Wins else if (finished2) ?#p2Wins else null;
    { state = { p1; p2; step = s.step + 1 }; verdict };
  };

  // ────────────────────────── the plug ────────────────────────────────────────

  /// Hand this to every duel-game-core engine call. Built fresh per call —
  /// function values are never stored, so upgrades stay trivial.
  /// `#simultaneous`: both cars step every round.
  public func spec() : TP.Spec<State, Action> = #simultaneous {
    init;
    validate;
    resolve;
  };
};
