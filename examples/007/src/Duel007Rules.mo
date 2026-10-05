/// Duel007Rules — the 007 duel, as a pure module. #p1 = BOND, #p2 = SILVA.
///
/// Rules:
///   LOAD    gain 1 ammo. 5 CONSECUTIVE loads charge the laser; any other
///           action resets the charge. (The deployed backend instead treats
///           any shot at ammo ≥ 5 as a laser — to reproduce that, replace
///           `hasLaser` with `func (a : AgentStats) : Bool = a.ammo >= 5`.)
///   SHOOT   spend 1 ammo (illegal at 0). With a full charge it fires the
///           LASER instead: pierces shield AND mirror, and spends the charge.
///   SHIELD  absorbs a normal shot. The 3rd absorbed hit still saves you but
///           BREAKS the shield; raising a broken shield is illegal.
///   MIRROR  reflects a normal shot back at the shooter. 3 uses total; each
///           use consumes one whether or not a shot arrives. Illegal at 0.
///
///   Both shoot in the same round → both die → draw. Laser vs laser → draw.
///   Laser vs normal shot → both die too (the shot was already in the air).

import TP "mo:duel-game-core";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: 007 duel
MODE: simultaneous
SEATS: p1 = BOND, p2 = SILVA
VARIANTS: none (the table variant text is ignored)

STATE (Candid)
  type Action = variant { load; shoot; shield; mirror };
  type AgentStats = record {
    ammo : nat;
    shieldHits : nat;
    mirrors : nat;
    charge : nat;
  };
  type Round = record {
    p1Action : Action;
    p2Action : Action;
    narration : text;
  };
  type State = record { p1 : AgentStats; p2 : AgentStats; lastRound : opt Round };
  ammo: shots available. shieldHits: hits the shield has absorbed, 3 =
  broken. mirrors: mirror uses left, starts at 3. charge: consecutive
  loads, 5 = laser ready. lastRound: the round just resolved with an
  English narration of it, null before the first.

ACTION (Candid)
  type Action = variant { load; shoot; shield; mirror };

RULES
  Each round both seats secretly pick one action.
  load    +1 ammo, +1 charge. Any other action resets charge to 0.
  shoot   spends 1 ammo. With charge >= 5 it fires the LASER instead:
          spends the charge and no ammo, and pierces shield and mirror.
  shield  absorbs a normal shot. The 3rd absorbed hit still saves the
          seat but breaks the shield.
  mirror  reflects a normal shot back at the shooter, who dies. Each use
          consumes one mirror whether or not a shot arrives.
  A normal shot at a seat that loads kills it.
  Rejected: shoot with 0 ammo and no laser, shield once it is broken
  (shieldHits >= 3), mirror with 0 mirrors.

ENDINGS
  A seat that is shot dies and the other wins.
  Both shoot in the same round, laser or not: both die, draw.

CLIENT NOTES
  A seat has the laser when its charge >= 5; shoot is then legal even
  at 0 ammo.
";

  public type Action = { #load; #shoot; #shield; #mirror };

  public type AgentStats = {
    ammo : Nat;
    shieldHits : Nat; // absorbed hits; 3 = broken
    mirrors : Nat; // uses remaining
    charge : Nat; // consecutive loads toward the laser
  };

  public type Round = {
    p1Action : Action;
    p2Action : Action;
    narration : Text;
  };

  public type State = {
    p1 : AgentStats; // BOND
    p2 : AgentStats; // SILVA
    lastRound : ?Round;
  };

  let SHIELD_CAPACITY : Nat = 3;
  let START_MIRRORS : Nat = 3;
  let LASER_CHARGE : Nat = 5;

  public func agentName(seat : TP.Seat) : Text = switch (seat) {
    case (#p1) "BOND";
    case (#p2) "SILVA";
  };

  func freshAgent() : AgentStats = {
    ammo = 0;
    shieldHits = 0;
    mirrors = START_MIRRORS;
    charge = 0;
  };

  public func init(_variant : Text) : State = {
    p1 = freshAgent();
    p2 = freshAgent();
    lastRound = null;
  };

  public func shieldBroken(a : AgentStats) : Bool = a.shieldHits >= SHIELD_CAPACITY;

  public func hasLaser(a : AgentStats) : Bool = a.charge >= LASER_CHARGE;

  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    let me = switch (seat) { case (#p1) s.p1; case (#p2) s.p2 };
    switch (a) {
      case (#load) null;
      case (#shoot) {
        if (me.ammo == 0 and not hasLaser(me)) ?"No ammo — LOAD first." else null;
      };
      case (#shield) {
        if (shieldBroken(me)) ?"Your shield is broken." else null;
      };
      case (#mirror) {
        if (me.mirrors == 0) ?"No mirrors left." else null;
      };
    };
  };

  /// Immediate, defense-independent effects of one agent's action.
  func applyAction(me : AgentStats, a : Action, laser : Bool, name : Text) : (AgentStats, Text) {
    switch (a) {
      case (#load) (
        { me with ammo = me.ammo + 1; charge = me.charge + 1 },
        name # " loads. ",
      );
      case (#shield) (
        { me with charge = 0 },
        name # " raises shield. ",
      );
      case (#mirror) (
        {
          me with mirrors = if (me.mirrors > 0) me.mirrors - 1 else 0;
          charge = 0;
        },
        name # " deploys mirror. ",
      );
      case (#shoot) {
        if (laser) (
          { me with charge = 0 },
          name # " fires LASER! ",
        ) else (
          { me with ammo = if (me.ammo > 0) me.ammo - 1 else 0; charge = 0 },
          name # " shoots. ",
        );
      };
    };
  };

  type ShotResult = {
    #defenderDies;
    #shooterDies; // mirrored back
    #absorbed;
    #absorbedAndBroke;
  };

  func resolveShot(defender : AgentStats, defense : Action, laser : Bool) : ShotResult {
    if (laser) return #defenderDies;
    switch (defense) {
      case (#mirror) #shooterDies;
      case (#shield) {
        if (defender.shieldHits + 1 >= SHIELD_CAPACITY) #absorbedAndBroke else #absorbed;
      };
      case (_) #defenderDies;
    };
  };

  public func resolve(s : State, a1 : Action, a2 : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {

    let laser1 = hasLaser(s.p1) and a1 == #shoot;
    let laser2 = hasLaser(s.p2) and a2 == #shoot;

    let (p1a, n1) = applyAction(s.p1, a1, laser1, agentName(#p1));
    let (p2a, n2) = applyAction(s.p2, a2, laser2, agentName(#p2));

    var p1 = p1a;
    var p2 = p2a;
    var alive1 = true;
    var alive2 = true;
    var narration = n1 # n2;

    if (a1 == #shoot and a2 == #shoot) {
      alive1 := false;
      alive2 := false;
      narration #= if (laser1 and laser2) "Both agents fire LASERS — mutual annihilation." else "Both agents fire simultaneously — standoff. Nobody walks away.";
    } else if (a1 == #shoot) {
      switch (resolveShot(p2, a2, laser1)) {
        case (#defenderDies) {
          alive2 := false;
          narration #= if (laser1) "The laser pierces every defense — " # agentName(#p2) # " is eliminated!" else agentName(#p2) # " is eliminated!";
        };
        case (#shooterDies) {
          alive1 := false;
          narration #= "The mirror reflects the shot — " # agentName(#p1) # " is eliminated!";
        };
        case (#absorbed) {
          p2 := { p2 with shieldHits = p2.shieldHits + 1 };
          narration #= "Shield absorbs the shot.";
        };
        case (#absorbedAndBroke) {
          p2 := { p2 with shieldHits = p2.shieldHits + 1 };
          narration #= "Shield absorbs the shot — and BREAKS!";
        };
      };
    } else if (a2 == #shoot) {
      switch (resolveShot(p1, a1, laser2)) {
        case (#defenderDies) {
          alive1 := false;
          narration #= if (laser2) "The laser pierces every defense — " # agentName(#p1) # " is eliminated!" else agentName(#p1) # " is eliminated!";
        };
        case (#shooterDies) {
          alive2 := false;
          narration #= "The mirror reflects the shot — " # agentName(#p2) # " is eliminated!";
        };
        case (#absorbed) {
          p1 := { p1 with shieldHits = p1.shieldHits + 1 };
          narration #= "Shield absorbs the shot.";
        };
        case (#absorbedAndBroke) {
          p1 := { p1 with shieldHits = p1.shieldHits + 1 };
          narration #= "Shield absorbs the shot — and BREAKS!";
        };
      };
    };

    let verdict : ?TP.Verdict = if (alive1 and alive2) null else if (alive1) ?#p1Wins else if (alive2) ?#p2Wins else ?#draw;

    {
      state = {
        p1 = p1;
        p2 = p2;
        lastRound = ?{ p1Action = a1; p2Action = a2; narration };
      };
      verdict;
    };
  };

  public func spec() : TP.Spec<State, Action> = #simultaneous {
    init;
    validate;
    resolve;
  };
};
