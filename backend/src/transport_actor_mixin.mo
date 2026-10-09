/// The non-generic half of `./transport`: every method whose signature
/// names none of the game's types, and the sweep timer. Each table
/// request replies with an `Ack` (the table and its `rev` after the
/// call); the client fetches the view with `duel_table`. The host
/// declares `duel_create_table`, `duel_lobby`, `duel_submit` and
/// `duel_table` itself — see `./transport`'s header. `lobby` is
/// `duel.lobby(env)`.
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import Transport "./transport";
import T "./types";

mixin <system>(lobby : Transport.Lobby) {

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

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(Transport.SWEEP_SECS),
      func() : async () { await* lobby.sweep<system>(Time.now()) },
    );
  };
  startSweeping<system>();

};
