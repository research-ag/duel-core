/// FakeTurnGame — a trivial `#alternating` `TP.Spec` used only by
/// Alternating.test.mo. INC always legal, +1 to a shared counter, never ends;
/// WINNOW illegal at 0, otherwise ends the match for the seat on turn.
import TP "../src/lib";

module {

  public type Action = { #inc; #winNow };

  public type State = { count : Nat };

  public func init(_ : Text) : State = { count = 0 };

  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    switch (a) {
      case (#inc) null;
      case (#winNow) if (s.count == 0) ?"Nothing to win with yet — INC first." else null;
    };
  };

  public func resolve(s : State, seat : TP.Seat, a : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    switch (a) {
      case (#inc) ({ state = { count = s.count + 1 }; verdict = null });
      case (#winNow) ({
        state = s;
        verdict = ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
      });
    };
  };

  /// Hand this to every engine call under test. `#alternating`: seats
  /// take turns, one move per submission — see `Table.toMove` for how
  /// the engine decides whose turn it is (p1 first, then alternating).
  public func spec() : TP.Spec<State, Action> = #alternating {
    init;
    validate;
    resolve;
  };
};
