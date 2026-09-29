import Float "mo:core/Float";
import Int "mo:core/Int";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Registry "mo:duel-game-core/registry";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import BotIface "BotIface";
import Rules "RacingRules";

persistent actor {

  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry = Registry.new<Rules.State, Rules.Action>(300_000_000_000, 45_000_000_000); // 300s idle timeout, 45s claim-win window, shared by every table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // Best-lap leaderboard: a plain, stable `Leaderboard.Board` this actor
  // owns directly, kept at 50 entries — see `../../backend/README.md`'s
  // "Leaderboard" section. Every board this framework ships sorts
  // highest-score-first, so a lower (better) lap time is converted into a
  // higher-is-better score right here, the one place this game's own
  // notion of "better" is known: one hour of headroom in milliseconds,
  // floored at zero for a race that (implausibly) runs longer.
  // `defaultScore` (the board's 2nd argument) is never actually consulted
  // here: unlike an ELO rating, a lap time is never "computed FROM" a
  // prior score (`recordIfBetter` below decides purely by comparing the
  // NEW score to whatever's on record, or its own capacity check for a
  // brand-new player), so this value is inert — 0 purely because `new`
  // requires SOME `Int`.
  let leaderboard = Leaderboard.new(50, 0);
  let ONE_HOUR_MS : Int = 3_600_000;
  func scoreFromLapMs(ms : Int) : Int = Int.max(0, ONE_HOUR_MS - ms);

  // The winner's lap time as the frontend's own HUD clock would compute
  // it (see examples/racing/frontend/src/app/modules/gameplay/game-shared/services/game-state.service.ts's
  // `raceTime` getter) — NOT real-world wall-clock time between the race
  // starting and this debrief landing, which would count however long
  // the two humans took to think between clicks, nothing to do with the
  // simulated race itself. Each resolved round is a fixed
  // `STEP_DURATION_MS` of in-game time (matching that same file's own
  // `stepDuration` constant — keep both in sync), so `turns` rounds is
  // `turns * STEP_DURATION_MS` of raw race time — except the winning car
  // doesn't necessarily need the WHOLE of its final round to cross the
  // line. `RacingRules.resolve`'s own lap-count logic increments `lap`
  // the instant a round's motion wraps `distanceFromStart` past the
  // track's own loop point (see that module's own `distanceFromStart`
  // field doc: "progress ... THIS LAP PASS" — it's reckoned fresh from
  // zero the moment a wrap happens) — so a car's `distanceFromStart` in
  // the very state that just won IS exactly how far PAST the finish line
  // that final round's own motion carried it, and `speed` (world units
  // per WHOLE round) how fast. `distanceFromStart / speed` is therefore
  // that round's own overshoot, expressed as a fraction of one round,
  // which gets subtracted back out of the raw round count so the
  // reported time lines up with the actual instant the car crossed, not
  // the round boundary after it. Clamped to `[0, 1)`: floating-point
  // slack (or a `speed` of exactly 0, guarded separately) could otherwise
  // push it slightly out of the one round it's meant to describe.
  let STEP_DURATION_MS : Int = 1000;
  func lapMsFor(car : Rules.CarState, turns : Nat) : Int {
    let overshootSteps = if (car.speed > 0.0) {
      Float.max(0.0, Float.min(0.999, car.distanceFromStart / car.speed));
    } else 0.0;
    Float.nearest((turns.toFloat() - overshootSteps) * STEP_DURATION_MS.toFloat()).toInt();
  };

  // Normalizes a session id down to a stable per-PLAYER key. `Ws.playerKey`
  // already handles `ii:`/`an:`; a `cp:` canister-player session is
  // deliberately PER-TABLE (`CanisterPlayers.sidForCanister`), so it's
  // special-cased here — the one place this actor already has both
  // `Ws`/`CanisterPlayers` wired — down to the bot's own stable principal
  // plus the complexity it raced at, so each of one bot's complexities
  // keeps its own best lap and that lap accumulates across every
  // table it races on instead of resetting per board.
  func playerKey(sid : TP.SessionId) : Text {
    if (CanisterPlayers.isCanisterSession(sid)) {
      CanisterPlayers.leaderboardKeyOfSession(sid);
    } else {
      Ws.playerKey(sid);
    };
  };

  // Fires once per race ending (see `Ws.OnGameEnded`'s own doc). Only a
  // clean `#finished` win records a lap time — a draw (an exact
  // photo-finish tie) has no completed winner, and `#claimed`/`#aborted`
  // mean nobody actually crossed the line either, so neither produces a
  // lap to score.
  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    switch (d.end) {
      case (#finished(#p1Wins)) {
        let lapMs = lapMsFor(d.finalGame.p1, d.turns);
        ignore Leaderboard.recordIfBetter(leaderboard, playerKey(p1), scoreFromLapMs(lapMs), Time.now());
      };
      case (#finished(#p2Wins)) {
        let lapMs = lapMsFor(d.finalGame.p2, d.turns);
        ignore Leaderboard.recordIfBetter(leaderboard, playerKey(p2), scoreFromLapMs(lapMs), Time.now());
      };
      case (_) {}; // draw, claimed, or aborted — nobody finished a lap
    };
  };

  // Breaks the circular dependency between `attached` and `cpAttached`
  // below — see `mo:duel-game-core/canister_players`'s doc header.
  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) {
      case (?f) await* f(now, id);
      case null {};
    };
  };

  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    IcWebSocketCdkTypes.WsInitParams(null, ?120_000),
    ?settle,
    ?onGameEnded,
    null,
  );
  attached.ws.init<system>();

  // Canister players (Flow 1, self-join — see ../../CLAUDE.md's "Canister
  // players" note). `botDirectory` is a plain, stable `CanisterPlayers.BotDirectory`
  // this actor owns directly (same "no class, no closures" shape as
  // `registry`/`leaderboard` above) — a bot self-registers into it via
  // `register_bot` (below), and `list_bots` reads it back joined with each
  // bot's own current best-lap score from `leaderboard`.
  let botDirectory = CanisterPlayers.newBotDirectory();

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    func(session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
      let p = CanisterPlayers.principalOfCanisterSession(session);
      let bot : BotIface.CanisterPlayer = actor (p.toText());
      try { await* k(?(await bot.make_move(req))) } catch (_) { await* k(null) };
    },
    func(id : TP.TableId, secs : Nat) : async* () {
      ignore Timer.setTimer<system>(#seconds secs, func() : async () { await* settle(Time.now(), id) });
    },
  );
  settleTable := ?cpAttached.settle;

  transient let combinedSweep = func(now : Int) : async* () {
    await* attached.sweep(now);
    await* cpAttached.sweep(now);
  };
  include ActorMixin<system>(attached.ws, combinedSweep);

  include Http(renderer.renderExposition, "/metrics");

  // `register_bot`/`unregister_bot`/`list_bots` (bot discovery — see
  // `../../backend/README.md`'s "Canister players" section) come from this
  // same mixin, alongside the six `*_as_canister` methods above.
  include CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard);

  // Supplies `get_leaderboard()` (the top 25 best laps, `Entry.score` the
  // STORED, ELO-shaped number — the frontend's own `formatScore` converts
  // it back to a real lap time for display) — no hand-declared query
  // needed.
  include LeaderboardActorMixin(leaderboard, 25);

};
