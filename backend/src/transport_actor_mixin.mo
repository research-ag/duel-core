/// The non-generic half of `./transport`: every request that names
/// neither `State` nor `Action`, the `duel_lobby` query, and the sweep
/// timer. Each table request replies with an `Ack` (the table and its
/// `rev` after the call); the client fetches the view with `duel_table`.
/// The host declares `duel_submit`/`duel_table` itself — see
/// `./transport`'s header. `lobby` is `Duel.lobby`.
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import Transport "./transport";
import T "./types";

mixin <system>(lobby : Transport.Lobby) {

  public shared ({ caller }) func duel_create_table(seat : T.Seat, visibility : T.TableVisibility, variant : Text) : async Transport.Ack {
    await* lobby.createTable<system>(caller, seat, visibility, variant);
  };

  public shared ({ caller }) func duel_join_table(tableId : T.TableId, seat : T.Seat, code : ?Text) : async Transport.Ack {
    await* lobby.joinTable<system>(caller, tableId, seat, code);
  };

  public shared ({ caller }) func duel_rematch(tableId : T.TableId) : async Transport.Ack {
    await* lobby.rematch<system>(caller, tableId);
  };

  public shared ({ caller }) func duel_leave(tableId : T.TableId, gen : Nat) : async Transport.Ack {
    await* lobby.leave<system>(caller, tableId, gen);
  };

  public shared ({ caller }) func duel_reset(tableId : T.TableId, gen : Nat) : async Transport.Ack {
    await* lobby.reset<system>(caller, tableId, gen);
  };

  public shared ({ caller }) func duel_claim_win(tableId : T.TableId, gen : Nat) : async Transport.Ack {
    await* lobby.claimWin<system>(caller, tableId, gen);
  };

  public shared ({ caller }) func duel_ack_ended(tableId : T.TableId) : async Transport.Ack {
    await* lobby.ackEnded<system>(caller, tableId);
  };

  /// Sent every `Transport.KEEP_ALIVE_SECS` while the caller waits at a
  /// table for an opponent; keeps that table open. Changes nothing else.
  public shared ({ caller }) func duel_keep_alive() : async T.Res<()> {
    lobby.keepAlive(caller);
  };

  /// The open tables and the caller's own; `#unchanged` while the
  /// lobby is still at `rev` (`0` = always answer).
  public shared query ({ caller }) func duel_lobby(rev : Nat) : async Transport.LobbyResult {
    lobby.lobby(caller, rev);
  };

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(Transport.SWEEP_SECS),
      func() : async () { await* lobby.sweep<system>(Time.now()) },
    );
  };
  startSweeping<system>();

};
