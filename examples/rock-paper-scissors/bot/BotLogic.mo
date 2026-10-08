import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";

import TP "mo:duel-game-core";
import Rules "../src/RockPaperScissorsRules";

module {

  func actionsFor(variant : Rules.Variant) : [Rules.Action] = switch (variant) {
    case (#classic) [#rock, #paper, #scissors];
    case (#well) [#rock, #paper, #scissors, #well];
  };

  /// SplitMix64's finalizer: spreads every input bit over the output.
  func mix(x0 : Nat64) : Nat64 {
    var x = x0 +% 0x9E3779B97F4A7C15;
    x := (x ^ (x >> 30)) *% 0xBF58476D1CE4E5B9;
    x := (x ^ (x >> 27)) *% 0x94D049BB133111EB;
    x ^ (x >> 31);
  };

  /// Uniform pick from the current variant's action set, seeded by
  /// `entropy` (`Time.now()` in `Bot.mo`). The seat is mixed in so two
  /// copies of this bot asked at the same instant still pick independently.
  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>, entropy : Int) : Rules.Action {
    let actions = actionsFor(req.game.variant);
    let seatSalt : Nat64 = switch (req.seat) { case (#p1) 1; case (#p2) 2 };
    let r = mix(Nat64.fromIntWrap(entropy) ^ mix(seatSalt));
    actions[Nat64.toNat(r % actions.size().toNat64())];
  };

};
