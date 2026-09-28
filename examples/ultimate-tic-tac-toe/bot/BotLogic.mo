import TP "mo:duel-game-core";
import Rules "../src/UltimateTicTacToeRules";

module {

  /// No lookahead, no win/block detection — picked deterministically from
  /// `req.turn` and the position itself. `moves.size()` keeps shrinking
  /// (and reshuffling which BOARDS are even in play) every ply, both
  /// because a placed mark is never free again and because `activeBoard`
  /// narrows the legal set to one local board most of the time — the same
  /// "the position itself keeps the formula from repeating" property
  /// `examples/tic-tac-toe/bot/BotLogic.mo`/`examples/checkers/bot/BotLogic.mo`
  /// rely on, so no per-seat multiplier is needed here either (contrast
  /// `examples/rock-paper-scissors/bot/BotLogic.mo`, whose fixed action
  /// set never changes shape at all). A stronger bot replaces only this
  /// last line; `legalActions` itself stays the same either way.
  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>) : Rules.Action {
    let moves = Rules.legalActions(req.game, req.seat);
    moves[req.turn % moves.size()];
  };

};
