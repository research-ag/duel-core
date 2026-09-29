import TP "mo:duel-game-core";
import Rules "../src/UltimateTicTacToeRules";

module {

  /// No lookahead: a deterministic pick from `legalActions` by turn.
  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

};
