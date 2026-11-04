// The Dots & Boxes bot canister: a canister player for the game's host.
// `play` seats it at a table (called by the page's 🤖 dialog), `register`
// lists it in the host's bot directory (called once by hand, as the
// controller), and `make_move` answers every ask as a query with a line
// from BotLogic, seeded from the clock so games differ.

import Principal "mo:core/Principal";
import Time "mo:core/Time";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "../src/DotsAndBoxesRules";

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

  // Called once by hand after both canisters are deployed (and again
  // after a reinstall of the game).
  public shared ({ caller }) func register(host : Principal.Principal, name : Text) : async () {
    assert caller.isController();
    let h : Host = actor (host.toText());
    await h.register_bot(name, BotLogic.COMPLEXITIES);
  };

  public shared ({ caller }) func unregister(host : Principal.Principal) : async () {
    assert caller.isController();
    let h : Host = actor (host.toText());
    await h.unregister_bot();
  };

  public query func make_move(req : TP.MoveRequest<Rules.View, Rules.Action>) : async Rules.Action {
    BotLogic.chooseMove(req, Time.now());
  };

};
