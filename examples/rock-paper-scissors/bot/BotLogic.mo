import TP "mo:duel-game-core";
import Rules "../src/RockPaperScissorsRules";

module {

  /// Every pick is always legal in rock-paper-scissors, so there's no
  /// `legalActions` to defer to — this just rotates through the fixed
  /// action set deterministically by `req.turn`. No lookahead, no
  /// awareness of `req.game`/`req.opponentLastMove` at all; a stronger bot
  /// replaces only this one lookup.
  ///
  /// The per-seat multiplier (1 for p1, 2 for p2) keeps two copies of this
  /// same bot from ties forever when they play each other — with a plain
  /// `turn % 3` on both sides they'd submit the identical pick every
  /// round, since neither depends on which seat it is. Multiplying p2's
  /// index by 2 instead just staggers the two rotations out of lock-step;
  /// it's still a fixed function of `turn` alone, not a strategy.
  let ACTIONS : [Rules.Action] = [#rock, #paper, #scissors];

  func seatMultiplier(seat : TP.Seat) : Nat = switch (seat) {
    case (#p1) 1;
    case (#p2) 2;
  };

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    ACTIONS[(req.turn * seatMultiplier(req.seat)) % ACTIONS.size()];
  };

};
