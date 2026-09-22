/// The checkers bot's move-selection logic, factored out of `Bot.mo` as a
/// plain, pure module — so it can be exercised directly in
/// `test/Bot.test.mo` (constructing a synthetic `TP.MoveRequest` by hand
/// and calling `chooseMove`, no actor/Candid round-trip at all — the same
/// "testing offline" pattern `../../../CLAUDE.md`'s "Canister players"
/// note describes) as well as wired live from `Bot.mo`'s own `make_move`.
///
/// Milestone-02's rule-following bot: reuse `CheckersRules.legalActions`
/// directly (it already enforces mandatory capture and the maximal-chain
/// rule — see that function's own doc) rather than re-deriving any of
/// those rules here, then pick one of the results. Because `validate` is
/// still the only legality gate the engine itself trusts (architecture
/// rule 4), a bot that got its own move generation slightly wrong could
/// still never land an illegal move — but reusing `legalActions` means
/// there's no "own move generation" here to get wrong in the first place.
/// Stateless by design (see the canister-players authoring guidance):
/// every call recomputes fresh from `req.game`, nothing is mirrored
/// locally.
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
