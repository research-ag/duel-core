/// duel-game-core/leaderboard_actor_mixin — the read-only `get_leaderboard`
/// Candid method a host actor exposes once it wires
/// `mo:duel-game-core/leaderboard`, packaged as a `mixin` the same way
/// `mo:duel-game-core/canister_players_actor_mixin` packages
/// `canister_players.mo`'s own six methods.
///
/// OPTIONAL, unlike `ActorMixin`: a host that never wires a leaderboard at
/// all never `include`s this mixin either, and pays no cost for skipping
/// it — there is no `<system>` capability here to make mandatory, and
/// nothing else in this package depends on it existing. A host that DOES
/// wire `Leaderboard.new`/`Ws.attach`'s `onGameEnded` should `include`
/// this one too rather than hand-roll the identical one-method wrapper
/// again — see `../README.md`'s "Leaderboard" section for the full worked
/// example and `examples/007/src/Host.mo`/`examples/checkers/src/Host.mo`/
/// `examples/racing/src/Host.mo` for it wired end to end.
///
/// Purely read-only — this mixin only ever calls `Leaderboard.top`, never
/// writes to `leaderboard`; every write happens from the host's own
/// `onGameEnded`/`onGameStarted` closures (see `ws.mo`'s own doc), well
/// before this method is ever reached.
import Leaderboard "./leaderboard";

mixin (leaderboard : Leaderboard.Board, shown : Nat) {

  /// The top `shown` entries, highest score first — a plain `query`, same
  /// class as `status` (side-effect-free, no race risk — see the root
  /// `CLAUDE.md`'s architecture rule 8). `shown` is fixed at `include`
  /// time, not per-call: a host that wants a caller-chosen page size
  /// instead can skip this mixin and hand-declare its own
  /// `get_leaderboard(n : Nat)` calling `Leaderboard.top(leaderboard, n)`
  /// directly.
  public query func get_leaderboard() : async [Leaderboard.Entry] {
    Leaderboard.top(leaderboard, shown);
  };

};
