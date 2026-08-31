/// Shared test-only fixtures for the racing test suites. NOT suffixed
/// `.test.mo` on purpose — `mops test` only discovers that suffix, and this
/// module has nothing to run on its own (see ../CLAUDE.md's Conventions).
///
/// Actually finishing a lap of the real track from `R.init()` takes a
/// long, physics-realistic drive — fine for a human playtester, far too
/// slow and non-deterministic for a unit test. `seedNearFinish` instead
/// reaches straight into a live `TP.Table`'s `#active` phase (a public,
/// `var` field — see `../../../backend/src/lib.mo`) and swaps in a car
/// that's one small, legal step from crossing the line, so a test can
/// submit ONE real move and exercise the engine's genuine
/// resolve → verdict → debrief path without simulating a whole race.
import TP "mo:duel-game-core";
import R "../src/RacingRules";
import Runtime "mo:core/Runtime";

module {

  public let STILL : R.Action = { l = 0.0; c = 0.0 };

  /// A car one small step from the finish line, on lap 1 — the starting
  /// grid sits right before this same spot (see RacingRules.mo's
  /// `resolve` comment), so every real race already has `lap = 1` after
  /// its very first move (a free crossing, not a real lap); this
  /// crossing — the second — is the one that completes an actual lap and
  /// (since LAPS_TO_WIN is 1, checked as `lap > LAPS_TO_WIN`) wins.
  /// Position/heading sit on Track.roadPath's wrap segment (last point →
  /// first point); `distanceFromStart` matches that spot, ~99.6% of the
  /// way around — see Rules.test.mo for how these were derived.
  public func nearFinish() : R.CarState = {
    position = (101.5761, -19.8641);
    rotation = 1.4090;
    speed = 0.0;
    lap = 1;
    distanceFromStart = 1976.72;
    crashPenaltyRemaining = 0;
  };

  /// The move that carries `nearFinish()` across the line.
  public let FINISH_MOVE : R.Action = { l = 5.0; c = 0.0 };

  /// A car parked at the same spot as `nearFinish`, but on lap 0 —
  /// consistent (position matches distanceFromStart) so it never
  /// spuriously wraps a lap while it just sits still waiting.
  public func idleCar() : R.CarState = { nearFinish() with lap = 0 };

  /// Overwrite a live `#active` table's game state — the seats, turn
  /// counter and activity timestamp the engine already set via real
  /// `join` calls are left untouched; only the two cars change.
  public func seedGame(t : TP.Table<R.State, R.Action>, p1 : R.CarState, p2 : R.CarState) {
    switch (t.phase) {
      case (#active a) {
        t.phase := #active({ a with game = { p1; p2; step = a.game.step } });
      };
      case (_) Runtime.trap("seedGame: table is not #active");
    };
  };

  /// p1 is one legal move from winning; p2 sits at the same spot on lap 0.
  public func seedP1NearFinish(t : TP.Table<R.State, R.Action>) {
    seedGame(t, nearFinish(), idleCar());
  };

}
