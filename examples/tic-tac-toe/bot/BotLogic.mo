import TP "mo:duel-game-core";
import Rules "../src/TicTacToeRules";

module {

  /// No lookahead, no win/block detection — picked deterministically from
  /// `req.turn` and the position itself (`moves.size()` shrinks by one
  /// every ply, since a placed mark is never free again), the same shape
  /// `examples/checkers/bot/BotLogic.mo` uses. A stronger bot replaces
  /// only this last line; `legalActions` itself stays the same either
  /// way.
  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

};
