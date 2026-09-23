import TP "mo:duel-game-core";
import Rules "../src/CheckersRules";

module {

  /// No lookahead, no material evaluation — picked deterministically from
  /// `req.turn` and the position itself (`moves.size()` varies with the
  /// board, so this isn't just "always the first legal move"), the
  /// baseline this milestone calls for. A stronger bot replaces only this
  /// last line; `legalActions` itself stays the same either way.
  public func chooseMove(req : TP.MoveRequest<Rules.State>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

};
