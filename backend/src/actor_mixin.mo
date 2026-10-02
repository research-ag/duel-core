import Time "mo:core/Time";
import Timer "mo:core/Timer";

import Transport "./transport";

/// `duel_request`/`duel_poll` plus the idle-sweep timer. `sweepFunc`
/// should be `Transport.Attached.sweep`, which marks the sessions it
/// evicts as changed.
mixin <system>(
  endpoint : Transport.Endpoint,
  sweepFunc : (Int) -> async* (),
) {

  public shared ({ caller }) func duel_request(msg : Blob) : async Blob {
    await* endpoint.request(caller, msg);
  };

  public shared query ({ caller }) func duel_poll(sid : Text, rev : Nat) : async Transport.PollResult {
    endpoint.poll(caller, sid, rev);
  };

  func startSweeping<system>() {
    ignore Timer.recurringTimer<system>(
      #seconds(300),
      func() : async () { await* sweepFunc(Time.now()) },
    );
  };
  startSweeping<system>();

};
