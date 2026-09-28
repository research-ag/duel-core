import TP "mo:duel-game-core";
import Rules "../src/RockPaperScissorsWellRules";

module {

  /// Every pick is always legal in rock-paper-scissors-well, so there's no
  /// `legalActions` to defer to — this just rotates through the fixed
  /// action set deterministically by `req.turn`. No lookahead, no
  /// awareness of `req.game`/`req.opponentLastMove` at all; a stronger bot
  /// replaces only this one lookup.
  ///
  /// The per-seat multiplier (1 for p1, 3 for p2 — 3 is coprime to the
  /// action set's own size of 4, so p2's rotation still visits all four
  /// symbols) keeps two copies of this same bot from submitting the
  /// identical pick every round forever when they play each other — with
  /// a plain `turn % 4` on both sides they'd tie in lock-step, since
  /// neither depends on which seat it is.
  let ACTIONS : [Rules.Action] = [#rock, #paper, #scissors, #well];

  func seatMultiplier(seat : TP.Seat) : Nat = switch (seat) {
    case (#p1) 1;
    case (#p2) 3;
  };

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    ACTIONS[(req.turn * seatMultiplier(req.seat)) % ACTIONS.size()];
  };

};
