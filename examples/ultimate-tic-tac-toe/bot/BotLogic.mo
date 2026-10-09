import TP "mo:duel-game-core";
import Rules "../src/UltimateTicTacToeRules";

module {

  /// No lookahead: a deterministic pick from `legalActions` by turn.
  public func chooseMove(req : TP.MoveRequest<Rules.View, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.step % moves.size()];
  };

};
