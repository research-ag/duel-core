/// duel-game-core/canister_players_actor_mixin — the six `*_as_canister`
/// Candid methods a host actor exposes once it wires
/// `mo:duel-game-core/canister_players`, packaged as a single `mixin`,
/// exactly the way `mo:duel-game-core/actor_mixin` packages `ws.mo`'s own
/// four `ws_*` methods plus its idle-sweep timer.
///
/// OPTIONAL, unlike `ActorMixin`: a host that never wires
/// `canister_players.mo` at all (no canister-seatable players) never
/// `include`s this mixin either, and pays no cost for skipping it — there
/// is no `<system>` capability here to make mandatory, and nothing else in
/// this package depends on it existing. A host that DOES wire
/// `CanisterPlayers.attach` should `include` this one too rather than
/// hand-roll the same six forwarding methods again — see
/// `../README.md`'s "Canister players" section for the full worked
/// example (`cpAttached`'s own construction, and the `settle`/
/// `armClaimCheck` indirection with `mo:duel-game-core/ws`) and
/// `examples/racing/src/Host.mo`/`examples/checkers/src/Host.mo` for it
/// wired end to end.
///
/// Every method here does nothing but derive `caller`'s own `cp:` session
/// (never a client-supplied one — see `canister_players.mo`'s own doc
/// header on why there's nothing to spoof) and forward straight into the
/// matching `CanisterPlayers.Attached` operation — no game logic
/// reimplemented at this layer, same discipline `ActorMixin` and
/// `Registry` itself already hold to. There is deliberately no
/// `submit_as_canister`: a canister player's move only ever arrives as
/// the direct reply to a call `canister_players.mo` itself made, never a
/// separately-arriving request (see that module's own doc header). There
/// is also deliberately no `rematch_as_canister`: see
/// `CanisterPlayers.Attached`'s own doc for why a canister seat never
/// needs to request one itself. `leave_as_canister`/`ack_ended_as_canister`/
/// `claim_win_as_canister`/`reset_as_canister` each take a `tableId` —
/// the same one `create_table_as_canister`/`join_table_as_canister`
/// returned — since a canister may be seated at more than one board at
/// once (see `canister_players.mo`'s own doc header on per-board
/// identity); a human player's own frontend disambiguates the same way,
/// just implicitly, by which table its own screen happens to be showing.
///
/// `CanisterPlayers.Attached` is not generic over a game's `S`/`M` (see
/// its own doc), so unlike `Ws.attach`'s `Attached`, this mixin needs no
/// type parameters of its own to match — one `include
/// CanisterPlayersActorMixin(cpAttached)` fits any game.
import CanisterPlayers "./canister_players";
import T "./types";

mixin (cpAttached : CanisterPlayers.Attached) {

  public shared ({ caller }) func create_table_as_canister(
    seat : T.Seat,
    visibility : T.TableVisibility,
  ) : async T.Res<T.TableId> {
    await* cpAttached.createTable(caller, seat, visibility);
  };

  public shared ({ caller }) func join_table_as_canister(
    id : T.TableId,
    seat : T.Seat,
    code : ?Text,
  ) : async T.Res<T.JoinOk> {
    await* cpAttached.joinTable(caller, id, seat, code);
  };

  public shared ({ caller }) func leave_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cpAttached.leave(caller, tableId, gen);
  };

  public shared ({ caller }) func ack_ended_as_canister(tableId : T.TableId) : async () {
    await* cpAttached.ackEnded(caller, tableId);
  };

  public shared ({ caller }) func claim_win_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cpAttached.claimWin(caller, tableId, gen);
  };

  public shared ({ caller }) func reset_as_canister(tableId : T.TableId, gen : Nat) : async T.Res<()> {
    await* cpAttached.reset(caller, tableId, gen);
  };

};
