import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";

import TP "mo:duel-game-core";
import Rules "../src/Duel007Rules";

module {

  /// Sent by `Bot.mo`'s `register`. Easy: a uniform random legal move.
  /// Medium: a weighted random pick shaped by both agents' public stats.
  /// Unknown values play Easy.
  public let COMPLEXITIES : [Text] = ["Easy", "Medium"];

  let ALL : [Rules.Action] = [#load, #shoot, #shield, #mirror];

  /// SplitMix64's finalizer: spreads every input bit over the output.
  func mix(x0 : Nat64) : Nat64 {
    var x = x0 +% 0x9E3779B97F4A7C15;
    x := (x ^ (x >> 30)) *% 0xBF58476D1CE4E5B9;
    x := (x ^ (x >> 27)) *% 0x94D049BB133111EB;
    x ^ (x >> 31);
  };

  /// `entropy` is `Time.now()` in `Bot.mo`; the seat is mixed in so two
  /// copies of the bot asked at the same instant pick independently.
  func random(req : TP.MoveRequest<Rules.State, Rules.Action>, entropy : Int) : Nat {
    let seatSalt : Nat64 = switch (req.seat) { case (#p1) 1; case (#p2) 2 };
    mix(Nat64.fromIntWrap(entropy) ^ mix(seatSalt)).toNat();
  };

  func other(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  func statsOf(s : Rules.State, seat : TP.Seat) : Rules.AgentStats = switch (seat) {
    case (#p1) s.p1;
    case (#p2) s.p2;
  };

  func isLegal(s : Rules.State, seat : TP.Seat, a : Rules.Action) : Bool = Rules.validate(s, seat, a) == null;

  public func legalActions(s : Rules.State, seat : TP.Seat) : [Rules.Action] {
    ALL.filter(func(a : Rules.Action) : Bool { isLegal(s, seat, a) });
  };

  /// The one exit for every complexity: `validate` has the last word, and
  /// LOAD is always legal.
  func checked(req : TP.MoveRequest<Rules.State, Rules.Action>, a : Rules.Action) : Rules.Action {
    if (isLegal(req.game, req.seat, a)) a else #load;
  };

  public func chooseMove(req : TP.MoveRequest<Rules.State, Rules.Action>, entropy : Int) : Rules.Action {
    checked(req, if (req.complexity == "Medium") mediumMove(req, entropy) else easyMove(req, entropy));
  };

  func easyMove(req : TP.MoveRequest<Rules.State, Rules.Action>, entropy : Int) : Rules.Action {
    let moves = legalActions(req.game, req.seat);
    moves[random(req, entropy) % moves.size()];
  };

  // Medium reads both public stat blocks and gives each legal action a
  // weight; the pick stays random so the bot is not exploitable.
  //   - Opponent cannot shoot: LOAD is safe and builds the laser. Shoot
  //     only when nothing can stop it (laser, or opponent has no shield
  //     and no mirror), or as a small gamble when there is no mirror.
  //   - Opponent holds the laser: it cannot be defended, so shoot for the
  //     draw.
  //   - Opponent is armed: mirror and shield are the defenses, LOAD only a
  //     rare gamble so two turtling bots still make progress; shoot when it cannot lose (own laser, or the opponent
  //     has no defense left) and when the opponent is one load from a
  //     laser. A shooter last round raises the mirror's weight.
  func weight(req : TP.MoveRequest<Rules.State, Rules.Action>, a : Rules.Action) : Nat {
    let s = req.game;
    let opSeat = other(req.seat);
    let me = statsOf(s, req.seat);
    let op = statsOf(s, opSeat);
    let opArmed = isLegal(s, opSeat, #shoot);
    let opUnblockable = Rules.shieldBroken(op) and op.mirrors == 0;
    let myLaser = Rules.hasLaser(me);
    let aggressive = req.opponentLastMove == ?#shoot;

    if (not opArmed) {
      switch (a) {
        case (#shoot) {
          if (myLaser or opUnblockable) 1 else if (op.mirrors == 0 and me.ammo >= 2) 2 else 0;
        };
        case (#load) if (myLaser or opUnblockable) 0 else 8;
        case (_) 0;
      };
    } else if (Rules.hasLaser(op)) {
      switch (a) {
        case (#shoot) 1;
        case (_) 0;
      };
    } else if (myLaser or opUnblockable) {
      switch (a) {
        case (#shoot) 8;
        case (#load) 0;
        case (_) 1;
      };
    } else {
      switch (a) {
        case (#mirror) if (aggressive) 7 else 4;
        case (#shield) 4;
        case (#shoot) if (op.charge + 1 >= 5) 5 else 2;
        case (#load) 1;
      };
    };
  };

  func mediumMove(req : TP.MoveRequest<Rules.State, Rules.Action>, entropy : Int) : Rules.Action {
    let moves = legalActions(req.game, req.seat);
    let weights = moves.map(func(a : Rules.Action) : Nat { weight(req, a) });
    let total = weights.foldLeft(0, Nat.add);
    if (total == 0) return moves[random(req, entropy) % moves.size()];
    var r = random(req, entropy) % total;
    var i = 0;
    while (r >= weights[i]) {
      r -= weights[i];
      i += 1;
    };
    moves[i];
  };

};
