import TP "mo:duel-game-core";
import Rules "RockPaperScissorsWellRules";

module {

  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.State, Rules.Action>) -> async Rules.Action;
  };

};
