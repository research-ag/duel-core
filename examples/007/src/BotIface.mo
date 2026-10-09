import Principal "mo:core/Principal";

import CanisterPlayers "mo:duel-game-core/canister_players";
import TP "mo:duel-game-core";

import Rules "Duel007Rules";

module {

  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.View, Rules.Action>) -> async Rules.Action;
  };

  /// Asks a seated bot canister for its move; the transport's `CallBot`.
  public func callBot<system>(bot : TP.PlayerId, req : TP.MoveRequest<Rules.View, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    let b : CanisterPlayer = actor (CanisterPlayers.principalOfCanisterSession(bot).toText());
    try { await* k<system>(?(await b.make_move(req))) } catch (_) {
      await* k<system>(null);
    };
  };

};
