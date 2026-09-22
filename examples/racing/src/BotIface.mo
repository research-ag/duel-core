/// The Candid interface a racing canister player must implement — the
/// `join_table_as_canister`-reachable counterpart to a browser's own
/// `GamePlugin`. `canister_players.mo`'s protocol is one call, one reply:
/// the host actor calls `make_move` with the round's own `MoveRequest`
/// (built from `Registry.status`, so it's exactly what a human's screen
/// would show) and treats the returned `Rules.Action` as the chosen move —
/// see `../../../CLAUDE.md`'s "Canister players" note and
/// `../../../backend/README.md`'s "Canister players" section for the full
/// design. `Bot.mo` in this same directory is this game's own minimal,
/// hardcoded-script implementation.
import TP "mo:duel-game-core";
import Rules "RacingRules";

module {

  public type CanisterPlayer = actor {
    make_move : (TP.MoveRequest<Rules.State>) -> async Rules.Action;
  };

};
