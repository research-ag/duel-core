import TP "mo:duel-game-core";
import Rules "../src/RockPaperScissorsRules";

module {

  /// Every pick is always legal (Well mode) or every pick but well is
  /// (Classic — see `Rules.validate`), so there's no `legalActions` to
  /// defer to — this just rotates through the CURRENT match's own action
  /// set deterministically by `req.turn`, reading which set that is off
  /// `req.game.variant` (never a hardcoded, per-canister constant: the
  /// SAME bot serves both variants, since a table's variant lives in
  /// state the bot is handed on every request). No lookahead, no
  /// awareness of `req.opponentLastMove` at all; a stronger bot replaces
  /// only this one lookup.
  ///
  /// The per-seat multiplier keeps two copies of this same bot from tying
  /// forever when they play each other — with a plain `turn % n` on both
  /// sides they'd submit the identical pick every round, since neither
  /// depends on which seat it is. Classic's 3-symbol rotation uses 2 for
  /// p2 (coprime to 3); Well's 4-symbol rotation uses 3 for p2 instead (2
  /// isn't coprime to 4 — it would only ever visit half the symbols).
  /// Either way it's still a fixed function of `turn` alone, not a
  /// strategy.
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
