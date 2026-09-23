/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core/elo — the standard chess-ELO rating formula, as pure
/// functions. No state, no `Time`, no dependency on `table.mo`/
/// `registry.mo`/`ws.mo` and no game-specific knowledge whatsoever: `update`
/// takes two ratings and a `Verdict`-shaped outcome and returns the two new
/// ratings, full stop. Any win/lose/draw game plugs straight into it —
/// `examples/007` and `examples/checkers` share this exact module despite
/// one being `#simultaneous` and the other `#alternating`, since all either
/// needs is who won.
///
/// A rating always moves after a game, win or lose (unlike a personal-best
/// metric — see `mo:duel-game-core/leaderboard`'s `setScore` vs
/// `recordIfBetter`): beating a higher-rated opponent gains more than
/// beating a lower-rated one, and the two ratings always move by exactly
/// opposite amounts (this module's own `Elo.test.mo` checks that zero-sum
/// property directly) — one player's gain is the other's identical loss,
/// same as real chess ELO.
///
/// Deliberately has no opinion on a new, never-rated player's STARTING
/// rating either — that's the host's own call, made once, where it builds
/// its `Leaderboard.Board` (`Leaderboard.new(keep, defaultScore)`); this
/// module only ever computes a NEXT rating from two given ones, never
/// invents a first one.
/// ═══════════════════════════════════════════════════════════════════════════

import Float "mo:core/Float";
import Int "mo:core/Int";

module {

  public type Outcome = { #aWins; #bWins; #draw };

  // The classic logistic expectation: how likely `self` is to beat `opp`,
  // purely as a function of the 400-point-per-decade rating gap.
  func expected(ratingSelf : Int, ratingOpp : Int) : Float {
    let gap = (ratingOpp - ratingSelf).toFloat();
    1.0 / (1.0 + Float.pow(10.0, gap / 400.0));
  };

  /// New `(ratingA, ratingB)` after one game between them, given who won —
  /// `k` controls how far a single game can move a rating (chess
  /// convention: 32 for a new/casual player, smaller for an established
  /// one; this module takes no view on which — it's a parameter, not a
  /// constant, so a host is free to vary it, e.g. by games played). Result
  /// is rounded to the nearest whole rating point, same as every real ELO
  /// implementation — ratings are conventionally integers.
  public func update(ratingA : Int, ratingB : Int, outcome : Outcome, k : Nat) : (Int, Int) {
    let (actualA, actualB) = switch (outcome) {
      case (#aWins) (1.0, 0.0);
      case (#bWins) (0.0, 1.0);
      case (#draw) (0.5, 0.5);
    };
    let expectedA = expected(ratingA, ratingB);
    let expectedB = 1.0 - expectedA;
    let kf = k.toFloat();
    let newA = ratingA.toFloat() + kf * (actualA - expectedA);
    let newB = ratingB.toFloat() + kf * (actualB - expectedB);
    (Float.nearest(newA).toInt(), Float.nearest(newB).toInt());
  };
};
