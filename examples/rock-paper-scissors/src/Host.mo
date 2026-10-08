import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Transport "mo:duel-game-core/transport";
import TransportActorMixin "mo:duel-game-core/transport_actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import Elo "mo:duel-game-core/elo";
import HttpActorMixin "mo:duel-game-core/http_actor_mixin";
import PT "mo:promtracker";
import Tracker "mo:promtracker/Tracker";

import BotIface "BotIface";
import Rules "RockPaperScissorsRules";

actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new();
  registry.setTimeouts(90_000_000_000, 60_000_000_000); // 90s idle, 60s claim window
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // See ../../backend/README.md, "Leaderboard".
  let STARTING_ELO : Int = 1200;
  let ELO_K : Nat = 32;
  let leaderboard = Leaderboard.new(50, STARTING_ELO);

  // A `cp:` session is per-table; rate a bot per principal + complexity.
  func playerKey(sid : TP.SessionId) : Text {
    if (CanisterPlayers.isCanisterSession(sid)) {
      CanisterPlayers.leaderboardKeyOfSession(sid);
    } else {
      Transport.playerKey(sid);
    };
  };

  // Every ending re-rates both seats; `#claimed`/`#aborted` count as wins.
  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    let outcome : Elo.Outcome = switch (d.end) {
      case (#finished(#p1Wins)) #aWins;
      case (#finished(#p2Wins)) #bWins;
      case (#finished(#draw)) #draw;
      case (#claimed(#p1)) #aWins;
      case (#claimed(#p2)) #bWins;
      case (#aborted(#p1)) #bWins;
      case (#aborted(#p2)) #aWins;
    };
    let k1 = playerKey(p1);
    let k2 = playerKey(p2);
    let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, ELO_K);
    let now = Time.now();
    Leaderboard.setScore(leaderboard, k1, r1, now);
    Leaderboard.setScore(leaderboard, k2, r2, now);
  };

  // Breaks the cycle between `attached` and `cpAttached`.
  transient var settleTable : ?((Int, TP.TableId) -> async* ()) = null;
  transient let settle = func(now : Int, id : TP.TableId) : async* () {
    switch (settleTable) {
      case (?f) await* f(now, id);
      case null {};
    };
  };

  transient let hub : Transport.Hub = Transport.createHub();
  transient let attached = Transport.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    hub,
    ?settle,
    ?onGameEnded,
    null,
  );

  let botDirectory = CanisterPlayers.newBotDirectory();

  transient let cpAttached = CanisterPlayers.attach<Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    attached.afterMutation,
    true, // `attached` settles through `onSettled`
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
  include TransportActorMixin<system>(attached.lobby, combinedSweep);

  public shared ({ caller }) func duel_submit(sid : Text, gen : Nat, turn : Nat, move : Rules.Action) : async Transport.Reply<Rules.State> {
    attached.reply(sid, await* attached.submit(caller, sid, gen, turn, move));
  };

  public shared query ({ caller }) func duel_poll(sid : Text, rev : Nat) : async Transport.PollResult<Rules.State> {
    attached.poll(caller, sid, rev);
  };

  include HttpActorMixin([
    ("/semantics", func() : Text = Rules.SEMANTICS),
    ("/metrics", renderer.renderExposition),
  ]);

  include CanisterPlayersActorMixin(cpAttached, botDirectory, ?leaderboard);

  include LeaderboardActorMixin(leaderboard, 25);
};
