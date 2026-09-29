/// FakeGame — a trivial `#simultaneous` `TP.Spec` used only by the test suites.
/// GATHER always legal, +1 resource. ATTACK illegal at 0 resource, spends 1;
/// both attack -> #draw, one attacks -> the attacker wins, neither -> continue.
import TP "../src/lib";

module {

  public type Action = { #gather; #attack };

  public type State = {
    p1 : Nat; // resource count
    p2 : Nat;
  };

  public func init(_ : Text) : State = { p1 = 0; p2 = 0 };

  func resourceOf(s : State, seat : TP.Seat) : Nat = switch (seat) {
    case (#p1) s.p1;
    case (#p2) s.p2;
  };

  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    switch (a) {
      case (#gather) null;
      case (#attack) {
        if (resourceOf(s, seat) == 0) ?"No resource — GATHER first." else null;
      };
    };
  };

  public func resolve(s : State, a1 : Action, a2 : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let attacked1 = a1 == #attack;
    let attacked2 = a2 == #attack;

    let p1 = switch (a1) {
      case (#gather) s.p1 + 1;
      case (#attack) if (s.p1 > 0) s.p1 - 1 else 0;
    };
    let p2 = switch (a2) {
      case (#gather) s.p2 + 1;
      case (#attack) if (s.p2 > 0) s.p2 - 1 else 0;
    };

    let verdict : ?TP.Verdict = if (attacked1 and attacked2) ?#draw else if (attacked1) ?#p1Wins else if (attacked2) ?#p2Wins else null;

    { state = { p1; p2 }; verdict };
  };

  /// Hand this to every engine call under test. `#simultaneous`: this
  /// fixture exercises the engine's default, both-seats-every-round mode
  /// — see FakeTurnGame.mo for the `#alternating` counterpart.
  public func spec() : TP.Spec<State, Action> = #simultaneous {
    init;
    validate;
    resolve;
  };
};
