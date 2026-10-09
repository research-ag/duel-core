/// FakeTurnGame — a trivial `#turnBased` `TP.Spec` used only by
/// Alternating.test.mo. INC always legal, +1 to a shared counter, never ends;
/// WINNOW illegal at 0, otherwise ends the match for the seat on turn.
/// Options "headStart" starts the counter at 1. Seats alternate, recorded
/// in `toMove` (p1 first).
import TP "../src/lib";

module {

  public type Action = { #inc; #winNow };

  public type State = { count : Nat; toMove : TP.Seat };

  public type Options = Text;

  public type View = State;

  public func checkOptions(_ : Options) : ?Text = null;

  public func init(options : Options, _ : TP.Rng) : State = {
    count = if (options == "headStart") 1 else 0;
    toMove = #p1;
  };

  public func toMove(s : State) : TP.Seat = s.toMove;

  public func view(s : State, _ : TP.Seat, _ : Bool) : View = s;

  func other(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public func validate(s : State, _seat : TP.Seat, a : Action) : ?Text {
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
      case (#inc) ({
        state = { count = s.count + 1; toMove = other(seat) };
        verdict = null;
      });
      case (#winNow) ({
        state = s;
        verdict = ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
      });
    };
  };

  /// Hand this to every engine call under test. `#turnBased`: the seat
  /// in `toMove` acts; `move` checks then applies.
  public func spec() : TP.Spec<State, Action, View, Options> = #turnBased {
    checkOptions;
    init;
    toMove;
    move = func(s : State, seat : TP.Seat, a : Action, _ : TP.Rng) : {
      #ok : { state : State; verdict : ?TP.Verdict };
      #err : Text;
    } = switch (validate(s, seat, a)) {
      case (?why) #err why;
      case null #ok(resolve(s, seat, a));
    };
    view;
  };
};
