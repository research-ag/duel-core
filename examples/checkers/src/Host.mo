// Host actor for checkers. This file barely ever changes between games —
// it forwards `status` as a plain query and wires `mo:duel-game-core/ws`
// for every mutating call. Copy verbatim; the only per-game line is the
// `Rules` import. Wires a multi-table LOBBY, not a single fixed board —
// anyone may open a table (open, or access-code protected to share with
// a friend out of band), and any number run independently and
// simultaneously; this game's own code never has to know or care.

import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Timer "mo:core/Timer";

import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import CanisterPlayers "mo:duel-game-core/canister_players";
import CanisterPlayersActorMixin "mo:duel-game-core/canister_players_actor_mixin";
import Leaderboard "mo:duel-game-core/leaderboard";
import LeaderboardActorMixin "mo:duel-game-core/leaderboard_actor_mixin";
import Elo "mo:duel-game-core/elo";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import BotIface "BotIface";
import Rules "CheckersRules";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, per table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  // ELO leaderboard: a plain, stable `Leaderboard.Board` this actor owns
  // directly, kept at 50 entries so a player dropping out of the shown
  // top 25 doesn't just vanish outright. `STARTING_ELO` (the common
  // chess-convention default for a never-rated player) is this game's
  // OWN call, passed straight to `new` — `mo:duel-game-core/elo` takes
  // no view on it. See `../../backend/README.md`'s "Leaderboard" section.
  let STARTING_ELO : Int = 1200;
  let ELO_K : Nat = 32;
  let leaderboard = Leaderboard.new(50, STARTING_ELO);

  // Normalizes a session id down to a stable per-PLAYER key. `Ws.playerKey`
  // already handles `ii:`/`an:`; a `cp:` canister-player session is
  // deliberately PER-TABLE (`CanisterPlayers.sidForCanister`), so it's
  // special-cased here — the one place this actor already has both
  // `Ws`/`CanisterPlayers` wired — down to the bot's own underlying,
  // stable principal, so one bot's rating accumulates across every table
  // it plays instead of resetting per board.
  func playerKey(sid : TP.SessionId) : Text {
    if (CanisterPlayers.isCanisterSession(sid)) {
      CanisterPlayers.leaderboardKey(CanisterPlayers.principalOfCanisterSession(sid));
    } else {
      Ws.playerKey(sid);
    };
  };

  // Fires once per game ending (see `Ws.OnGameEnded`'s own doc): re-rates
  // both seats via the standard ELO formula. `#claimed`/`#aborted` count
  // the same as a clean `#finished` win — leaving mid-game or stalling
  // out isn't a free way to protect a rating. Mode-agnostic: this only
  // ever reads `Debrief.end`, never `finalGame`, so it works the same way
  // whether the seat that ended it got there via `#alternating` play
  // (this game) or `#simultaneous` (007/racing).
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
    let k1 = playerKey(p1);
    let k2 = playerKey(p2);
    let (r1, r2) = Elo.update(Leaderboard.scoreOf(leaderboard, k1), Leaderboard.scoreOf(leaderboard, k2), outcome, ELO_K);
    let now = Time.now();
    Leaderboard.setScore(leaderboard, k1, r1, now);
    Leaderboard.setScore(leaderboard, k2, r2, now);
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
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
    ?settle,
    ?onGameEnded,
    null, // no race-start timing needed — this game scores by Verdict alone
  );
  attached.ws.init<system>();

  // Canister players (Flow 1, self-join — see ../../CLAUDE.md's "Canister
  // players" note). `botDirectory` is a plain, stable `CanisterPlayers.BotDirectory`
  // this actor owns directly (same "no class, no closures" shape as
  // `registry`/`leaderboard` above) — a bot self-registers into it via
  // `register_bot` (below), and `list_bots` reads it back joined with each
  // bot's own current ELO from `leaderboard`.
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

  // Supplies `get_leaderboard()` (the top 25 ELO ratings) — no hand-declared
  // query needed.
  include LeaderboardActorMixin(leaderboard, 25);
};
