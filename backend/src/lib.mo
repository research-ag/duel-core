/// duel-game-core — a generic 2-player multi-table session engine.
///
/// This module is the package's shared type surface: everything in
/// `./types` re-exported so a host actor names it off one import
/// (`mo:duel-game-core`). Operations live in `./table`
/// (`mo:duel-game-core/table`, the single-board primitive) and
/// `./registry` (`mo:duel-game-core/registry`, the multi-table router).
///
/// Every mutating `Registry` operation is driven exclusively through
/// `mo:duel-game-core/transport` — never a plain Candid method — because two
/// independent update calls have no guaranteed relative processing order.
/// Only `status` is a plain public `query`; `http_request` and the
/// controllers-only `wasm_upload_*` of `./http_actor_mixin` touch no
/// game state.
///
///   import TP "mo:duel-game-core";
///   import Registry "mo:duel-game-core/registry";
///   import Transport "mo:duel-game-core/transport";
///
///   actor {
///     let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new();
///     registry.setTimeouts(90_000_000_000, 60_000_000_000);
///
///     public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
///       registry.status(Rules.spec(), Time.now(), sid);
///     };
///
///     // Transport.attach + include TransportActorMixin + the typed
///     // duel_submit/duel_poll pass-throughs — see `./transport`
///   };
///
/// `Registry<S, M>`/`Table<S, M>` are stable whenever `S`/`M` are; the
/// `Spec` is passed on every call and never stored. A stable `registry`
/// skips `Registry.new` on upgrade, so the host re-applies its timeouts
/// with `registry.setTimeouts` on the very next line.
///
/// Design guarantees (see `../README.md`, "Design"): race-free rematch
/// (create-then-join with a reserved seat), no ghost lobbies (every phase
/// timestamped), server-side legality (`validate` for both seats), no
/// silent endings (`#aborted`/`#claimed`/`#endedByOther`), leave means
/// left (an acked debrief seat is no longer a participant), replay-safe
/// (`gen`/`turn` mismatches come back `#stale`). `Spec` is tagged by
/// `Mode`; in `#alternating` the engine tracks whose turn it is and only
/// the waiting seat may `claimWin`.

import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Text "mo:core/Text";

import Table "./table";
import T "./types";

module {

  public type TableId = T.TableId;
  public type TableVisibility = T.TableVisibility;
  public type SessionId = T.SessionId;
  public type Seat = T.Seat;
  public type Verdict = T.Verdict;
  public type Mode = T.Mode;
  public type Registry<S, M> = T.Registry<S, M>;
  public type TableSummary = T.TableSummary;
  public type SessionStatus<S> = T.SessionStatus<S>;
  public type MoveRequest<S, M> = T.MoveRequest<S, M>;
  public type Spec<S, M> = T.Spec<S, M>;
  public type Staging = T.Staging;
  public type Active<S, M> = T.Active<S, M>;
  public type End = T.End;
  public type Debrief<S> = T.Debrief<S>;
  public type Phase<S, M> = T.Phase<S, M>;
  public type Ended = T.Ended;
  public type Table<S, M> = T.Table<S, M>;
  public type Err = T.Err;
  public type Res<T> = T.Res<T>;
  public type JoinOk = T.JoinOk;
  public type SubmitOk = T.SubmitOk;
  public type RematchOk = T.RematchOk;
  public type View<S> = T.View<S>;

};
