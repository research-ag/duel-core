// Reference host actor, wired exactly as the duel-game-core README shows.
import TP "mo:duel-game-core";
import Rules "../Duel007Rules";
import Time "mo:core/Time";

persistent actor {
  // Implicitly stable under `persistent actor` (moc 1.x); mutation happens
  // through the record's inner `var` fields, so `let` suffices.
  let table : TP.Table<Rules.State, Rules.Action> =
    TP.create(60_000_000_000); // 60 s idle timeout

  public func join(sid : Text, seat : TP.Seat) : async TP.Res<TP.JoinOk> {
    TP.join(Rules.spec(), table, Time.now(), sid, seat);
  };
  public func submit(sid : Text, a : Rules.Action) : async TP.Res<TP.SubmitOk> {
    TP.submit(Rules.spec(), table, Time.now(), sid, a);
  };
  public func rematch(sid : Text) : async TP.Res<TP.RematchOk> {
    TP.rematch(Rules.spec(), table, Time.now(), sid);
  };
  public func leave(sid : Text) : async TP.Res<()> {
    TP.leave(table, Time.now(), sid);
  };
  public func reset(sid : Text) : async TP.Res<()> {
    TP.reset(table, Time.now(), sid);
  };
  public func ackEnded(sid : Text) : async () {
    TP.ackEnded(table, sid);
  };
  public query func status(sid : Text) : async TP.View<Rules.State> {
    TP.status(table, Time.now(), sid);
  };
};
