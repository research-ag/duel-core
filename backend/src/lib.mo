/// duel-game-core — a generic 2-player multi-table session engine.
///
/// This module is the package's shared type surface: everything in
/// `./types` re-exported so a host actor names it off one import
/// (`mo:duel-game-core`). Operations live in `./table`
/// (`mo:duel-game-core/table`, the single-board primitive) and
/// `./registry` (`mo:duel-game-core/registry`, the multi-table router).
///
/// Every client read and mutation goes through `mo:duel-game-core/transport`
/// — never a plain Candid method; `http_request` of `./http_actor_mixin`
/// touches no game state. The overall design, with diagrams: `../../DESIGN.md`.
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
///       sweeper = Transport.sweeper();
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
/// next and only the waiting seat may `claimWin`. A `#code` table is an
/// invite: it waits `Table.INVITE_WAIT_NS` for the friend, and its first
/// moves get `Table.INVITE_GRACE_NS` on both clocks.

import T "./types";

module {

  /// `TableId` from `./types`.
  public type TableId = T.TableId;
  /// `TableVisibility` from `./types`.
  public type TableVisibility = T.TableVisibility;
  /// `PlayerId` from `./types`.
  public type PlayerId = T.PlayerId;
  /// `Seat` from `./types`.
  public type Seat = T.Seat;
  /// `Verdict` from `./types`.
  public type Verdict = T.Verdict;
  /// `Mode` from `./types`.
  public type Mode = T.Mode;
  /// `Rng` from `./types`.
  public type Rng = T.Rng;
  /// `Registry` from `./types`.
  public type Registry<S, M, O> = T.Registry<S, M, O>;
  /// `TableSummary` from `./types`.
  public type TableSummary<O> = T.TableSummary<O>;
  /// `MoveRequest` from `./types`.
  public type MoveRequest<V, M> = T.MoveRequest<V, M>;
  /// `Spec` from `./types`.
  public type Spec<S, M, V, O> = T.Spec<S, M, V, O>;
  /// `Staging` from `./types`.
  public type Staging = T.Staging;
  /// `Active` from `./types`.
  public type Active<S, M> = T.Active<S, M>;
  /// `End` from `./types`.
  public type End = T.End;
  /// `Debrief` from `./types`.
  public type Debrief<S> = T.Debrief<S>;
  /// `Phase` from `./types`.
  public type Phase<S, M> = T.Phase<S, M>;
  /// `Ended` from `./types`.
  public type Ended = T.Ended;
  /// `Table` from `./types`.
  public type Table<S, M, O> = T.Table<S, M, O>;
  /// `Err` from `./types`.
  public type Err = T.Err;
  /// `Res` from `./types`.
  public type Res<T> = T.Res<T>;
  /// `JoinOk` from `./types`.
  public type JoinOk = T.JoinOk;
  /// `SubmitOk` from `./types`.
  public type SubmitOk = T.SubmitOk;
  /// `RematchOk` from `./types`.
  public type RematchOk = T.RematchOk;
  /// `TableView` from `./types`.
  public type TableView<V> = T.TableView<V>;

};
