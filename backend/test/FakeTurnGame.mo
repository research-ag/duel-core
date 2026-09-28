/// FakeTurnGame — a deliberately trivial `TP.Spec` in `#alternating` mode,
/// used ONLY by Alternating.test.mo to exercise the engine's turn-order
/// dispatch (`Table.toMove`, `Err.#notYourTurn`, single-move `resolve`,
/// claim-win gated to the waiting seat). Not a real game, no rendering —
/// see FakeGame.mo for the `#simultaneous` counterpart this mirrors.
///
///   INC     always legal; bumps a shared counter by 1. Never ends the game.
///   WINNOW  illegal at count == 0 (so `validate`-rejection is exercised
///           too); otherwise ends the match immediately, crediting
///           whichever seat is on turn.
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
