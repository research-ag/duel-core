/// The standard chess-ELO formula, pure and game-agnostic. Zero-sum: one
/// player's gain is the other's loss. Has no opinion on a starting
/// rating — that is the host's `Leaderboard.new(keep, defaultScore)`.

import Float "mo:core/Float";
import Int "mo:core/Int";

module {

  public type Outcome = { #aWins; #bWins; #draw };

  func expected(ratingSelf : Int, ratingOpp : Int) : Float {
    let gap = (ratingOpp - ratingSelf).toFloat();
    1.0 / (1.0 + Float.pow(10.0, gap / 400.0));
  };

  /// New `(ratingA, ratingB)` after one game; `k` bounds a single game's
  /// movement (32 is the common casual default). Rounded to integers.
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
