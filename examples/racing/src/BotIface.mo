import TP "mo:duel-game-core";
import Rules "RacingRules";

module {

  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.State>) -> async Rules.Action;
  };

};
