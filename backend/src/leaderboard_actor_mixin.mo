/// Supplies the read-only `get_leaderboard` query for a host that wires
/// `mo:duel-game-core/leaderboard`. Writes happen in the host's own
/// `onGameEnded`/`onGameStarted` closures.
import Leaderboard "./leaderboard";

mixin (leaderboard : Leaderboard.Board, shown : Nat) {

  public query func get_leaderboard() : async [Leaderboard.Entry] {
    Leaderboard.top(leaderboard, shown);
  };

};
