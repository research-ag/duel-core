/// duel-game-core — a generic 2-player multi-table session engine.
///
/// This module is the package's shared type surface: everything in
/// `./types` re-exported so a host actor names it off one import
/// (`mo:duel-game-core`). Operations live in `./table`
/// (`mo:duel-game-core/table`, the single-board primitive) and
/// `./registry` (`mo:duel-game-core/registry`, the multi-table router).
///
/// Every client read and mutation goes through `mo:duel-game-core/transport`
/// — never a plain Candid method; `http_request` and the
/// controllers-only `wasm_upload_*` of `./http_actor_mixin` touch no
/// game state. The overall design, with diagrams: `../../DESIGN.md`.
///
///   import TP "mo:duel-game-core";
///   import Registry "mo:duel-game-core/registry";
///   import Transport "mo:duel-game-core/transport";
///
///   actor {
///     let duel = Transport.new<Rules.State, Rules.Action, Rules.Options>();
///     duel.registry.setTimeouts(90_000_000_000, 60_000_000_000);
///     transient let env : Transport.Env<Rules.State, Rules.Action, Rules.View, Rules.Options> = {
///       spec = Rules.spec;
///       bots = null;
///       scoring = null;
///     };
///     // include TransportActorMixin<system>(duel.lobby(env)) + the four
///     // host-declared pass-throughs — see `./transport`
///   };
///
/// `Registry<S, M, O>`/`Table<S, M, O>` are stable whenever `S`/`M`/`O` are; the
/// `Spec` is passed on every call and never stored. A stable `duel`
/// skips `Transport.new` on upgrade, so the host re-applies its timeouts
/// with `duel.registry.setTimeouts` on the very next line.
///
/// Design guarantees (see `../README.md`, "Design"): race-free rematch
/// (create-then-join with a reserved seat), no ghost lobbies (every phase
/// timestamped), server-side legality (the rules check every action), no
/// silent endings (`#aborted`/`#claimed`/`#endedByOther`), leave means
/// left (an acked debrief seat is no longer a participant), replay-safe
/// (`gen`/`step` mismatches come back `#stale`), hidden information stays
/// hidden (every view goes through the game's `view`). `Spec` is tagged
/// by `Mode`; in `#turnBased` the rules' `toMove` says whose action is
/// next and only the waiting seat may `claimWin`.

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
  public type PlayerId = T.PlayerId;
  public type Seat = T.Seat;
  public type Verdict = T.Verdict;
  public type Mode = T.Mode;
  public type Rng = T.Rng;
  public type Registry<S, M, O> = T.Registry<S, M, O>;
  public type TableSummary<O> = T.TableSummary<O>;
  public type MoveRequest<V, M> = T.MoveRequest<V, M>;
  public type Spec<S, M, V, O> = T.Spec<S, M, V, O>;
  public type Staging = T.Staging;
  public type Active<S, M> = T.Active<S, M>;
  public type End = T.End;
  public type Debrief<S> = T.Debrief<S>;
  public type Phase<S, M> = T.Phase<S, M>;
  public type Ended = T.Ended;
  public type Table<S, M, O> = T.Table<S, M, O>;
  public type Err = T.Err;
  public type Res<T> = T.Res<T>;
  public type JoinOk = T.JoinOk;
  public type SubmitOk = T.SubmitOk;
  public type RematchOk = T.RematchOk;
  public type TableView<V> = T.TableView<V>;

};
