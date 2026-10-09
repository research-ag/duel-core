import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "../src/CheckersRules";

actor {

  type Host = actor {
    join_table_as_canister : (TP.TableId, TP.Seat, ?Text, Text) -> async TP.Res<TP.JoinOk>;
    register_bot : (Text, [Text]) -> async ();
    unregister_bot : () -> async ();
  };

  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text, complexity : Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code, complexity);
  };

  // Called once by hand after both canisters are deployed.
  public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
    assert caller.isController();
    let h : Host = actor (host.toText());
    await h.register_bot(name, []);
  };

  public shared ({ caller }) func unregister(host : Principal.Principal) : async () {
    assert caller.isController();
    let h : Host = actor (host.toText());
    await h.unregister_bot();
  };

  public query func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
    BotLogic.chooseMove(req);
  };

};
