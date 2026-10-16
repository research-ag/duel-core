/// One-off upgrade migration for a host whose live build predates player
/// ids: top-level `registry` (keyed by session ids, `variant : Text`
/// tables), `botDirectory`, the HTTP mixin's `wasm` and, for an ELO host,
/// `ELO_K` and `STARTING_ELO` (`OldWithElo`). It rebuilds them as `duel` and `bots` and keeps every table,
/// the bot directory, the leaderboard and the metrics. The host supplies
/// the game's part: its table options from the old variant text, and its
/// new state from the old state and the old turn count. See README,
/// "Upgrading from the session layout".
import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import Time "mo:core/Time";
import PT "mo:promtracker";

import CanisterPlayers "./canister_players";
import Rng "./rng";
import T "./types";
import Transport "./transport";

module {

  public type OldActive<S, M> = {
    p1 : Text;
    p2 : Text;
    game : S;
    pending1 : ?M;
    pending2 : ?M;
    turn : Nat;
    lastActivity : Int;
    roundStartedAt : Int;
    lastRoundDurationNs : ?Int;
    lastMoveP1 : ?M;
    lastMoveP2 : ?M;
  };

  public type OldDebrief<S> = {
    p1 : Text;
    p2 : Text;
    end : T.End;
    turns : Nat;
    finalGame : S;
    since : Int;
  };

  public type OldPhase<S, M> = {
    #empty;
    #staging : T.Staging;
    #active : OldActive<S, M>;
    #debrief : OldDebrief<S>;
  };

  public type OldTable<S, M> = {
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    visibility : T.TableVisibility;
    createdBy : Text;
    variant : Text;
    var phase : OldPhase<S, M>;
    var gen : Nat;
    var lastEnded : [T.Ended];
    var debriefAcked : [Text];
  };

  public type OldRegistry<S, M> = {
    var idleTimeoutNs : Int;
    var claimTimeoutNs : Int;
    var tables : Map.Map<T.TableId, OldTable<S, M>>;
    var bySession : Map.Map<Text, T.TableId>;
    var tableIdNonce : T.TableId;
    var gamesStarted : ?PT.Counter;
    var activeGames : ?PT.Gauge;
    var roundsPerGame : ?PT.Gauge;
    var matchmakingWaitSecs : ?PT.Gauge;
  };

  public type Old<S, M> = {
    registry : OldRegistry<S, M>;
    botDirectory : CanisterPlayers.BotDirectory;
    wasm : { var live : [Blob]; staged : List.List<Blob> };
  };

  /// `Old` of a host rated by ELO, which also kept its two constants.
  public type OldWithElo<S, M> = Old<S, M> and {
    ELO_K : Nat;
    STARTING_ELO : Int;
  };

  public type New<S, M, O> = {
    duel : Transport.Duel<S, M, O>;
    bots : CanisterPlayers.Store;
  };

  /// The game's part of the migration.
  public type Game<SO, S, O> = {
    /// A table's options from its old variant text.
    options : Text -> O;
    /// The new state from the old one and the old turn count (the number
    /// of actions applied so far).
    state : (SO, Nat) -> S;
  };

  /// The seat the old engine had on turn in `#alternating` mode.
  public func seatOnTurn(turn : Nat) : T.Seat = if (turn % 2 == 0) #p1 else #p2;

  /// The player id of an old session id: `ii:<p>` and `an:<p>` become
  /// `<p>`, `cp:<p>:<tableId>:<complexity>` becomes
  /// `cp:<p>:<complexity>`; anything else is kept.
  public func playerOf(sid : Text) : T.PlayerId {
    let humanPrefixes = ["ii:", "an:"];
    for (prefix in humanPrefixes.values()) {
      switch (sid.stripStart(#text prefix)) {
        case (?p) return p;
        case null {};
      };
    };
    switch (sid.stripStart(#text(CanisterPlayers.CP_ID_PREFIX))) {
      case (?rest) {
        let parts = rest.split(#char ':');
        switch (parts.next(), parts.next()) {
          case (?p, ?_tableId) {
            CanisterPlayers.CP_ID_PREFIX # p # ":" # CanisterPlayers.normalizeComplexity(parts.join(":"));
          };
          case _ sid;
        };
      };
      case null sid;
    };
  };

  func players(sids : [Text]) : [T.PlayerId] = sids.map(playerOf);

  func phase<SO, S, M, O>(game : Game<SO, S, O>, p : OldPhase<SO, M>) : T.Phase<S, M> = switch (p) {
    case (#empty) #empty;
    case (#staging s) #staging {
      seat = s.seat;
      session = playerOf(s.session);
      reservedFor = switch (s.reservedFor) {
        case (?r) ?playerOf(r);
        case null null;
      };
      since = s.since;
    };
    case (#active a) #active {
      p1 = playerOf(a.p1);
      p2 = playerOf(a.p2);
      game = game.state(a.game, a.turn);
      pending1 = a.pending1;
      pending2 = a.pending2;
      step = a.turn;
      lastActivity = a.lastActivity;
      stepStartedAt = a.roundStartedAt;
      lastStepDurationNs = a.lastRoundDurationNs;
      lastMoveP1 = a.lastMoveP1;
      lastMoveP2 = a.lastMoveP2;
    };
    case (#debrief d) #debrief {
      p1 = playerOf(d.p1);
      p2 = playerOf(d.p2);
      end = d.end;
      steps = d.turns;
      finalGame = game.state(d.finalGame, d.turns);
      since = d.since;
    };
  };

  func table<SO, S, M, O>(game : Game<SO, S, O>, t : OldTable<SO, M>) : T.Table<S, M, O> = {
    var idleTimeoutNs = t.idleTimeoutNs;
    var claimTimeoutNs = t.claimTimeoutNs;
    visibility = t.visibility;
    createdBy = playerOf(t.createdBy);
    options = game.options(t.variant);
    var phase = phase(game, t.phase);
    var gen = t.gen;
    var lastEnded = t.lastEnded.map(
      func(e : T.Ended) : T.Ended = {
        p1 = playerOf(e.p1);
        p2 = playerOf(e.p2);
        acked = players(e.acked);
        since = e.since;
      }
    );
    var debriefAcked = players(t.debriefAcked);
    var rev = 0;
  };

  public func run<SO, S, M, O>(old : Old<SO, M>, game : Game<SO, S, O>) : New<S, M, O> {
    let r = old.registry;
    {
      duel = {
        registry = {
          var idleTimeoutNs = r.idleTimeoutNs;
          var claimTimeoutNs = r.claimTimeoutNs;
          var tables = r.tables.map<T.TableId, OldTable<SO, M>, T.Table<S, M, O>>(
            func(_, t) = table(game, t)
          );
          var tableIdNonce = r.tableIdNonce;
          var gamesStarted = r.gamesStarted;
          var activeGames = r.activeGames;
          var roundsPerGame = r.roundsPerGame;
          var matchmakingWaitSecs = r.matchmakingWaitSecs;
        };
        var lobbyRev = 0;
        presence = Map.empty<T.PlayerId, Int>();
        rng = Rng.new(Nat64.fromIntWrap(Time.now()));
      };
      bots = {
        directory = old.botDirectory;
        inFlight = Map.empty<Text, ()>();
        replying = Map.empty<T.TableId, Nat>();
      };
    };
  };

};
