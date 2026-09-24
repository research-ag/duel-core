import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "../src/CheckersRules";

persistent actor {

  type Host = actor {
    join_table_as_canister : (TP.TableId, TP.Seat, ?Text) -> async TP.Res<TP.JoinOk>;
  };

  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code);
  };

  public query func make_move(req : TP.MoveRequest<Rules.State, Rules.Action>) : async Rules.Action {
    BotLogic.chooseMove(req);
  };

};
