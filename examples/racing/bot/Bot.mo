/// A minimal, deliberately "dumb" canister player for the racing game —
/// implements `BotIface.CanisterPlayer`, the milestone-01 hardcoded-script
/// bot from the canister-players design (see `../../../CLAUDE.md`'s
/// "Canister players" note). All the actual move-selection logic lives in
/// `BotLogic.mo`, kept as a plain pure module so it can be tested directly
/// (see `test/Bot.test.mo`) without going through this actor at all; this
/// file is just the thin Candid shell around it, plus the Flow 1
/// "self-join" entry point below. It never wins a race and doesn't try
/// to — the point of this canister is to prove `canister_players.mo`'s
/// call/response wiring end to end with the simplest possible bot logic.
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "../src/RacingRules";

persistent actor {

  /// The slice of a `Host.mo`-shaped game canister's own Candid surface
  /// this bot needs to seat itself — the canister-authenticated lifecycle
  /// method `mo:duel-game-core/canister_players` wires onto every host
  /// actor that opts into canister players.
  type Host = actor {
    join_table_as_canister : (TP.TableId, TP.Seat, ?Text) -> async TP.Res<TP.JoinOk>;
  };

  /// Flow 1, self-join (see the canister-players design's "Lobby &
  /// opponent selection" section): a human creates a `#code` table on
  /// `host` as usual, then hands this bot the table id, seat, and code —
  /// however they like (this is the whole of "outside this engine's
  /// concern" the design calls for; a real bot might gate this behind an
  /// allowlist or a concurrency cap, see that section's "Bot self-defense"
  /// callout — this example doesn't need either). The bot then joins on
  /// its own account; `host` derives this canister's `cp:` session from
  /// ITS OWN caller principal (this call's `msg.caller`), never from
  /// anything asserted here — there's nothing for a caller of `play` to
  /// spoof.
  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code);
  };

  public query func make_move(req : TP.MoveRequest<Rules.State>) : async Rules.Action {
    BotLogic.chooseMove(req);
  };

};
