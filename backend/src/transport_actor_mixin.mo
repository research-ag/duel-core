/// The non-generic half of `./transport`: every request that names
/// neither `State` nor `Action`, plus the idle-sweep timer. Each reply is
/// an `Ack` (the caller's `rev` after the call); the client fetches the
/// view with `duel_poll`. The host declares `duel_submit`/`duel_poll`
/// itself — see `./transport`'s header. `sweepFunc` should be
/// `Transport.Attached.sweep` (or a host's combination with
/// `CanisterPlayers.Attached.sweep`), which marks the sessions it evicts
/// as changed.
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import Transport "./transport";
import T "./types";

mixin <system>(lobby : Transport.Lobby, sweepFunc : (Int) -> async* ()) {

  public shared ({ caller }) func duel_create_table(sid : Text, seat : T.Seat, visibility : T.TableVisibility, variant : Text) : async Transport.Ack {
    await* lobby.createTable(caller, sid, seat, visibility, variant);
  };

  public shared ({ caller }) func duel_join_table(sid : Text, id : T.TableId, seat : T.Seat, code : ?Text) : async Transport.Ack {
    await* lobby.joinTable(caller, sid, id, seat, code);
  };

  public shared ({ caller }) func duel_rematch(sid : Text) : async Transport.Ack {
    await* lobby.rematch(caller, sid);
  };

  public shared ({ caller }) func duel_leave(sid : Text, gen : Nat) : async Transport.Ack {
    await* lobby.leave(caller, sid, gen);
  };

  public shared ({ caller }) func duel_reset(sid : Text, gen : Nat) : async Transport.Ack {
    await* lobby.reset(caller, sid, gen);
  };

  public shared ({ caller }) func duel_claim_win(sid : Text, gen : Nat) : async Transport.Ack {
    await* lobby.claimWin(caller, sid, gen);
  };

  public shared ({ caller }) func duel_ack_ended(sid : Text) : async Transport.Ack {
    await* lobby.ackEnded(caller, sid);
  };

  /// The first request of a connection, the relink, and the heartbeat:
  /// keeps the session present (a query could not).
  public shared ({ caller }) func duel_ping(sid : Text) : async Transport.Ack {
    lobby.ping(caller, sid);
  };

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(300),
      func() : async () { await* sweepFunc(Time.now()) },
    );
  };
  startSweeping<system>();

};
