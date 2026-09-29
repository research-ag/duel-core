import TP "mo:duel-game-core";
import Rules "../src/RockPaperScissorsRules";

module {

  /// Rotates through the current variant's action set by turn. The p2
  /// multiplier (coprime to the set size) keeps two copies of this bot
  /// from tying forever.
  func actionsFor(variant : Rules.Variant) : [Rules.Action] = switch (variant) {
    case (#classic) [#rock, #paper, #scissors];
    case (#well) [#rock, #paper, #scissors, #well];
  };

  func seatMultiplier(variant : Rules.Variant, seat : TP.Seat) : Nat = switch (seat) {
    case (#p1) 1;
    case (#p2) switch (variant) {
      case (#classic) 2;
      case (#well) 3;
    };
  };

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let actions = actionsFor(req.game.variant);
    actions[(req.turn * seatMultiplier(req.game.variant, req.seat)) % actions.size()];
  };

};
