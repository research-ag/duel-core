/// The five `*_as_canister` Candid methods (join/leave/ack_ended/
/// claim_win/reset) plus bot discovery
/// (`register_bot`/`unregister_bot`/`list_bots`) for a host that wires
/// `mo:duel-game-core/canister_players`. Every method derives the
/// caller's own `cp:` player id from `caller` and forwards; no game logic
/// here. `endpoint` is `Duel.canisterPlayers` (a `Duel` built with bots). There is deliberately no `submit_as_canister` (a move only ever
/// arrives as the reply to `make_move`) and no `rematch_as_canister`.
/// `leaderboard` may be `null`, in which case every `elo` is `null`.
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";

import CanisterPlayers "./canister_players";
import Leaderboard "./leaderboard";
import T "./types";

mixin (endpoint : ?CanisterPlayers.Endpoint, directory : CanisterPlayers.BotDirectory, leaderboard : ?Leaderboard.Board) {

  transient let cp : CanisterPlayers.Endpoint = switch (endpoint) {
    case (?e) e;
    case null Runtime.trap("CanisterPlayersActorMixin needs a Duel built with bots");
  };

  public shared ({ caller }) func join_table_as_canister(
    id : T.TableId,
    seat : T.Seat,
    code : ?Text,
    complexity : Text,
  ) : async T.Res<T.JoinOk> {
    await* cp.joinTable<system>(caller, id, seat, code, complexity);
  };

  public shared ({ caller }) func leave_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cp.leave<system>(caller, tableId, gen);
  };

  public shared ({ caller }) func ack_ended_as_canister(tableId : T.TableId) : async () {
    await* cp.ackEnded<system>(caller, tableId);
  };

  public shared ({ caller }) func claim_win_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cp.claimWin<system>(caller, tableId, gen);
  };

  public shared ({ caller }) func reset_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cp.reset<system>(caller, tableId, gen);
  };

  /// Idempotent upsert keyed by `caller`. `complexities` is the bot's own
  /// list of ways to play (`[]` = listed under "Default").
  public shared ({ caller }) func register_bot(name : Text, complexities : [Text]) : async () {
    CanisterPlayers.registerBot(directory, caller, name, complexities, Time.now());
  };

  public shared ({ caller }) func unregister_bot() : async () {
    CanisterPlayers.unregisterBot(directory, caller);
  };

  /// Every registered bot ranked by rating, each complexity joined with
  /// its own leaderboard row via `CanisterPlayers.leaderboardKey`.
  public query func list_bots() : async [CanisterPlayers.BotEntry] {
    let scoreOf = switch (leaderboard) {
      case (?lb) func(p : Principal.Principal, complexity : Text) : ?Int = ?Leaderboard.scoreOf(lb, CanisterPlayers.leaderboardKey(p, complexity));
      case null func(_ : Principal.Principal, _ : Text) : ?Int = null;
    };
    CanisterPlayers.rankedBots(CanisterPlayers.listBots(directory), scoreOf);
  };

};
