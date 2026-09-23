import Time "mo:core/Time";

import TP "mo:duel-game-core";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import Registry "mo:duel-game-core/registry";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import Elo "mo:duel-game-core/elo";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import Rules "Duel007Rules";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  // A lobby of tables, not one fixed board — anyone may open a new table
  // (open, or access-code protected) and the same canister routes every
  // move to the right one. See `mo:duel-game-core`'s own doc header.
  let registry = Registry.new<Rules.State, Rules.Action>(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, shared by every table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // ELO leaderboard: a plain, stable `Leaderboard.Board` this actor owns
  // directly (no `Registry`/`ws.mo` involvement beyond the `onGameEnded`
  // hook below) — kept at 50 entries so a player dropping out of the
  // shown top 25 doesn't just vanish outright, and someone climbing from
  // 26th can still surface. `STARTING_ELO` (the common chess-convention
  // default for a never-rated player) is this game's OWN call, passed
  // straight to `new` — `mo:duel-game-core/elo` takes no view on it. See
  // `../../backend/README.md`'s "Leaderboard" section.
  let STARTING_ELO : Int = 1200;
  let ELO_K : Nat = 32;
  let leaderboard = Leaderboard.new(50, STARTING_ELO);

  // Fires once per game ending (see `Ws.OnGameEnded`'s own doc): re-rates
  // both seats via the standard ELO formula. `#claimed`/`#aborted` count
  // the same as a clean `#finished` win — leaving mid-game or stalling
  // out isn't a free way to protect a rating.
  func onGameEnded(_id : TP.TableId, p1 : TP.SessionId, p2 : TP.SessionId, d : TP.Debrief<Rules.State>) {
    let outcome : Elo.Outcome = switch (d.end) {
      case (#finished(#p1Wins)) #aWins;
      case (#finished(#p2Wins)) #bWins;
      case (#finished(#draw)) #draw;
      case (#claimed(#p1)) #aWins;
      case (#claimed(#p2)) #bWins;
      case (#aborted(#p1)) #bWins; // p1 left — p2 credited with the win
      case (#aborted(#p2)) #aWins;
    };
    let k1 = Ws.playerKey(p1);
    let k2 = Ws.playerKey(p2);
    let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, ELO_K);
    let now = Time.now();
    Leaderboard.setScore(leaderboard, k1, r1, now);
    Leaderboard.setScore(leaderboard, k2, r2, now);
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
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
    null,
    ?onGameEnded,
    null, // no race-start timing needed — this game scores by Verdict alone
  );
  attached.ws.init<system>();

  // `attached.sweep` (not a bare `TP.sweep(table, Time.now())`) pushes a
  // fresh view to every session the idle sweep just evicted — see
  // `Ws.Attached`'s own doc.
  include ActorMixin<system>(attached.ws, attached.sweep);

  include Http(renderer.renderExposition, "/metrics");

  // Supplies `get_leaderboard()` (the top 25 ELO ratings) — no hand-declared
  // query needed.
  include LeaderboardActorMixin(leaderboard, 25);
};
