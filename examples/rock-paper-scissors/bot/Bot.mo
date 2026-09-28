import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "../src/RockPaperScissorsRules";

persistent actor {

  type Host = actor {
    join_table_as_canister : (TP.TableId, TP.Seat, ?Text) -> async TP.Res<TP.JoinOk>;
    register_bot : (Text) -> async ();
    unregister_bot : () -> async ();
  };

  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code);
  };

  // Self-registration — a one-time call made once after both this
  // canister and `host` are deployed (e.g. `icp canister call bot
  // register '(principal "<host-id>", "RockPaperScissorsBot")'`), so
  // `host`'s own "🤖 Bots" challenge dialog and leaderboard Challenge
  // buttons can find this bot with no hardcoded canister id anywhere on
  // the frontend — see `../../../backend/README.md`'s "Canister players"
  // section. `caller` on `host`'s own `register_bot` is `msg.caller` —
  // THIS canister's own principal, never something passed here — so
  // there's nothing to spoof; `host` is only ever the address this call
  // is SENT to.
  public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
    assert Principal.isController(caller);
    let h : Host = actor (host.toText());
    await h.register_bot(name);
  };

  public shared ({ caller }) func unregister(host : Principal.Principal) : async () {
    assert Principal.isController(caller);
    let h : Host = actor (host.toText());
    await h.unregister_bot();
  };

  public query func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
    BotLogic.chooseMove(req);
  };

};
