/// A rule-following canister player for checkers — implements
/// `BotIface.CanisterPlayer`, the milestone-02 bot from the
/// canister-players design (see `../../../CLAUDE.md`'s "Canister
/// players" note): every reply is enumerated via
/// `CheckersRules.legalActions`, so it can never submit an illegal move,
/// even though it does no lookahead of its own (see `BotLogic.mo`'s own
/// doc header). All the actual move-selection logic lives there, kept as
/// a plain pure module so it can be tested directly (see
/// `test/Bot.test.mo`) without going through this actor at all; this file
/// is just the thin Candid shell around it, plus the Flow 1 "self-join"
/// entry point below.
import Principal "mo:core/Principal";

import TP "mo:duel-game-core";

import BotLogic "BotLogic";
import Rules "CheckersRules";

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
  /// concern" the design calls for). The bot then joins on its own
  /// account; `host` derives this canister's `cp:` session from ITS OWN
  /// caller principal (this call's `msg.caller`), never from anything
  /// asserted here — there's nothing for a caller of `play` to spoof.
  public shared func play(host : Principal.Principal, tableId : TP.TableId, seat : TP.Seat, code : ?Text) : async TP.Res<TP.JoinOk> {
    let h : Host = actor (host.toText());
    await h.join_table_as_canister(tableId, seat, code);
  };

  public shared func make_move(req : TP.MoveRequest<Rules.State>) : async Rules.Action {
    BotLogic.chooseMove(req);
  };

};
