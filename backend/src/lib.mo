/// ═══════════════════════════════════════════════════════════════════════════
/// duel-game-core — a generic 2-player multi-table lobby session engine.
///
/// Game-agnostic core for any turn-based, simultaneous-reveal 2-player game:
///
///   • anyone may open a new TABLE (open, for anyone to browse and join, or
///     protected with an access code to share with a friend out of band) —
///     any number of tables run independently and simultaneously; the
///     `Registry` (`./registry`, below) is what creates them and routes
///     every session's calls to the right one (seats #p1 / #p2 per table)
///   • rounds: a `#simultaneous` game has each seated player submit one
///     move; when both are in, the game's `resolve` runs and either
///     continues the game or ends it. An `#alternating` game instead
///     resolves the instant the one on-turn seat submits a single move
///     — see `Mode`'s own doc below for the full contract
///   • a finished game puts BOTH players in a #debrief (win / lose / draw)
///   • a player may LEAVE early: both players get a special debrief
///     (`end = #aborted seat`) instead of the game silently vanishing
///   • once your own move has sat pending against your opponent's silence
///     for longer than `claimTimeoutNs`, you may — optionally, never
///     automatically — CLAIM the win outright (`end = #claimed seat`)
///     instead of waiting out the much longer full-board idle eviction; a
///     shorter, independent clock from `idleTimeoutNs`, meant to give the
///     waiting player a real choice well before that
///   • during the debrief, either previous player can request a REMATCH,
///     reusing the SAME table; two simultaneous rematch requests converge
///     race-free (see below), the reserved partner may DECLINE it instead
///     of only accepting or letting it time out, and requesting one after
///     your partner already left doesn't reserve a seat for them — it
///     opens immediately instead of waiting on someone who's gone for good
///   • `leave` from a debrief dismisses it for YOU specifically — your own
///     `status`/`join`/`rematch` stop treating you as a participant of it
///     immediately, even though the underlying phase legitimately stays
///     #debrief until your partner also leaves (or it expires), so their
///     own rematch option isn't cut short by your exit
///   • after `idleTimeoutNs` of inactivity, third parties may take over:
///     claim a squatted staging seat, reset a dead game, or start fresh
///     over an expired debrief — discoverable through `Registry.listTables`
///     the same as any other joinable table — or a host may call
///     `Registry.sweep` on its own periodic timer to free an abandoned
///     table even with no visitor around to trigger that lazily (and
///     garbage-collect it once fully quiesced — including pruning any
///     #endedByOther notice nobody plausibly still owes a look at, so a
///     participant who's never coming back to acknowledge one doesn't
///     pin that table's id in the registry forever — so table ids don't
///     accumulate without bound)
///   • every session gets one truthful `Registry.status` view: either the
///     browsable table list, or a specific table's own screen — including
///     the proactive #endedByOther notice when a game was ripped away
///
/// This module (`lib.mo`, imported as `mo:duel-game-core`, no subpath) is
/// the package's shared type surface — `Spec`, `Seat`, `Phase`, `View`,
/// `Err`, `Res`, `Registry`, `Table`, and everything else below is defined
/// once in `./types` and re-exported here so every other module (and every
/// host actor) can name them off ONE import. The actual operations live in
/// two sibling modules, both built on those same types:
///
///   • `./table` (`mo:duel-game-core/table`) — the low-level, single-table
///     primitive: `Table.new(idleTimeoutNs, claimTimeoutNs, visibility,
///     createdBy)` plus `.join`/`.submit`/`.rematch`/`.leave`/`.reset`/
///     `.claimWin`/`.ackEnded`/`.status`/`.sweep` on the `Table<S, M>` it
///     returns (Motoko's dot-notation call sugar — these are plain
///     functions taking the table as their first argument). A game that
///     genuinely wants exactly one fixed board, with no lobby of its own,
///     can use this directly instead of `Registry`.
///   • `./registry` (`mo:duel-game-core/registry`) — a thin router layered
///     on top of `Table`: `Registry.new(idleTimeoutNs, claimTimeoutNs)`
///     plus `.createTable`/`.listTables`/`.joinTable`/`.submit`/
///     `.rematch`/`.leave`/`.reset`/`.claimWin`/`.ackEnded`/`.status`/
///     `.sweep` on the `Registry<S, M>` it returns. Every one of
///     `Registry`'s mutating operations except
///     `createTable`/`joinTable` just resolves the caller's own current
///     table (a `SessionId -> TableId` mapping it keeps) and delegates
///     straight into the matching `Table` operation above — no game logic
///     or legality is reimplemented at this layer. Every design guarantee
///     below holds at either layer; `Registry` adds table creation/
///     discovery/routing on top without changing any of it.
///
/// ── How a host actor wires it ──────────────────────────────────────────────
///
/// Every mutating operation (`Registry.createTable`/`joinTable`/`submit`/
/// `rematch`/`leave`/`reset`/`claimWin`/`ackEnded`) is driven EXCLUSIVELY
/// through
/// `mo:duel-game-core/ws`'s `ws_message` — there is no plain Candid method
/// for any of them, and no fallback: a direct update call is exactly the
/// race a WS-only transport exists to close (two independent update calls
/// have no guaranteed relative processing order once both are in flight;
/// see `src/ws.mo`'s doc header). Only `status` stays a plain public
/// `query` — it's side-effect-free, so it carries no such race risk, and
/// it's useful for tooling/tests that don't want a WS handshake:
///
///   import TP "mo:duel-game-core";
///   import Registry "mo:duel-game-core/registry";
///   import Ws "mo:duel-game-core/ws";
///   import ActorMixin "mo:duel-game-core/actor_mixin";
///   import Rules "YourGameRules"; // any module implementing TP.Spec<S, M>
///   import Time "mo:core/Time";
///
///   persistent actor {
///     let registry : TP.Registry<Rules.State, Rules.Action> =
///       Registry.new(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, per table
///
///     public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
///       registry.status(Rules.spec(), Time.now(), sid);
///     };
///
///     // ...wire Ws.attach (dispatches every request straight into
///     // registry.createTable/joinTable/submit/... above, with
///     // Time.now()) and `include ActorMixin<system>(attached.ws,
///     // attached.sweep)` for the four ws_* Candid methods plus the
///     // idle-sweep timer — see `src/ws.mo`'s doc header for the full
///     // wiring and `backend/README.md`'s "Real-time push" section for
///     // the worked example end to end.
///   };
///
/// `Registry<S, M>` (and the plain `Table<S, M>` it's built from) is a
/// stable type whenever the game's state `S` and move `M` are stable types.
/// The `Spec` (functions) is passed on every call and never stored, so the
/// engine survives upgrades with no migration gymnastics.
///
/// A host actor may also opt into Prometheus-style metrics by calling
/// `Registry.attachMetrics(pt)` with a `pt : mo:promtracker`'s `Tracker` —
/// unlike `mo:duel-game-core/ws`, this is entirely opt-in instrumentation:
/// a host that never calls it just leaves those counters/gauges
/// unpopulated, with no other behavioral effect. See `backend/README.md`'s
/// "Metrics" section for the metrics it exposes and the full wiring
/// (`examples/racing/src/Host.mo` is a worked example).
///
/// ── Design guarantees (each maps to a bug class found in the wild) ─────────
///
///   1. RACE-FREE REMATCH. `rematch` from #debrief stages a new game, on the
///      SAME table, with the open seat RESERVED for the partner — unless
///      the partner already acked (left) this same debrief, in which case
///      the seat opens unreserved instead of waiting on someone who's gone
///      for good; the partner's own `rematch` (or a `Registry.joinTable`
///      onto that same table) pattern-matches that staging and seats them,
///      or `leave` (carrying the `gen` `#awaitingRematch` supplies) DECLINES
///      it, freeing just the reservation. Because the actor serializes
///      update messages, two simultaneous rematch clicks always execute as
///      create-then-join — nobody can be stranded.
///   2. NO GHOST LOBBIES. Every phase carries its own timestamp (`since` /
///      `lastActivity`), stamped at creation — a first joiner who vanishes is
///      evictable after the timeout, not squatting forever, and (at the
///      `Registry` layer) a table's idle-expired phase resurfaces through
///      `listTables` in every phase, not just while it's freshly `#empty`.
///   3. SERVER-SIDE LEGALITY. The engine calls `spec.validate` on every
///      submitted move for BOTH players — a game plugged in here cannot be
///      cheated by a client bypassing UI button states.
///   4. NO SILENT ENDINGS. Aborting yields a shared #aborted debrief; an
///      overdue opponent may instead be claimed as a win (`#claimed seat`,
///      via `claimWin` — the submitter's own optional choice, never
///      automatic, once the opponent's move has sat pending past
///      `claimTimeoutNs`); an idle takeover records the evicted players so
///      `status` shows them #endedByOther until they acknowledge
///      (`ackEnded` / any re-entry) —
///      or, failing that (nobody plausibly still coming back to look), until
///      `Table.pruneEnded` drops the notice on its own during a later
///      `sweep`, so one participant who never returns can't pin the notice,
///      and (at the `Registry` layer) the table it lives on, forever.
///   5. LEAVE MEANS LEFT. `status`/`join`/`rematch` all treat a session that
///      already acked its own debrief (via `leave`) as no longer a
///      participant of it, even while the phase itself lingers in #debrief
///      for the still-deciding partner. Without this, "Return to lobby"
///      kept showing that same player the identical #debrief screen (with
///      live Rematch/Leave buttons) until the partner ALSO left — visually
///      indistinguishable from the button doing nothing at all. (At the
///      `Registry` layer, leaving also returns the session to "browsing" —
///      see `Registry.leave`'s own doc for the one deliberate exception: the
///      abort itself, which still shows the leaver their own debrief.)
///   6. REPLAY-SAFE. `submit`/`leave`/`reset`/`claimWin` all take a `gen`
///      (and, for `submit`, `turn`) the caller must have last observed via
///      `status`;
///      a mismatch against the table's CURRENT `Table.gen`/round comes back
///      `#stale` instead of being applied. This closes a real class of bug:
///      a client can't always tell whether a mutating call it believes
///      failed (a dropped connection, a decode error) actually landed —
///      `frontend/src/ws/gateway-client.ts`'s resend queue exists to retry
///      exactly that ambiguous case — and without this check, a resent
///      `submit` whose original copy secretly already resolved the round
///      (or the whole match) would be silently replayed against whatever
///      round/match is current by then, and a resent `leave`/`reset` could
///      silently abort a brand-new match the SAME session later started
///      (typically a same-partner rematch) instead of the one it actually
///      meant to end. `join`/`rematch`/`ackEnded` need no such binding —
///      each already recomputes its effect from live state (current
///      partner, current seat availability, current debrief membership)
///      rather than applying a stale payload, so a replay of any of them is
///      already either a no-op or a pre-existing, harmless error.
///
/// `Spec<S, M>` is tagged by `Mode`, so a game picks its own shape:
/// `#simultaneous` (both seats submit every round; `resolve` takes both
/// moves at once — everything described above) or `#alternating` (seats
/// take turns in order; `resolve` takes just the one on-turn seat's
/// move, and the engine tracks whose turn it is on its own, from the
/// match's own round counter — a game's `S` never needs a turn flag of
/// its own). Idle takeover and claim-a-win both still apply to an
/// `#alternating` table exactly as described above, with one
/// restriction: only the seat currently WAITING on the other's turn may
/// claim — the seat whose own turn it is can't, since they're the one
/// holding up the game, not the one waiting on it.
/// ═══════════════════════════════════════════════════════════════════════════

import Array "mo:core/Array"; // enables [T].concat dot notation
import Int "mo:core/Int"; // enables Int.toNat dot notation
import Map "mo:core/Map"; // Registry's table/session maps
import Nat "mo:core/Nat"; // TableId ordering
import Option "mo:core/Option";
import Text "mo:core/Text"; // SessionId ordering

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
