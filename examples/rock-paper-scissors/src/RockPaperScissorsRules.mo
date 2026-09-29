/// RockPaperScissorsRules — a pure `#simultaneous` module with two
/// table-time variants, Classic and Well. #p1/#p2 are unnamed.
///
/// Rules:
///   Classic: each round both players secretly pick ROCK, PAPER, or
///   SCISSORS. Scissors beats Paper, Paper beats Rock, Rock beats Scissors.
///
///   Well: a fourth symbol, WELL, joins the three:
///     - Scissors beats Paper.
///     - Paper beats Rock and Well.
///     - Rock beats Scissors.
///     - Well beats Rock and Scissors.
///   Every distinct pair has exactly one winner (a complete but
///   deliberately unbalanced tournament). WELL is illegal in Classic.
///
///   The same pick from both sides is a tied round. First to WINS_NEEDED
///   round wins takes the match.

import TP "mo:duel-game-core";

module {

  public type Variant = { #classic; #well };

  /// Unrecognized text (including `""`) falls back to `#classic`.
  public func parseVariant(raw : Text) : Variant = switch (raw) {
    case ("well") #well;
    case (_) #classic;
  };

  public type Action = { #rock; #paper; #scissors; #well };

  public type Round = {
    p1Action : Action;
    p2Action : Action;
  };

  public type State = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Round;
    variant : Variant;
  };

  let WINS_NEEDED : Nat = 3;

  public func init(raw : Text) : State = {
    p1Score = 0;
    p2Score = 0;
    lastRound = null;
    variant = parseVariant(raw);
  };

  public func validate(s : State, _seat : TP.Seat, a : Action) : ?Text {
    switch (a, s.variant) {
      case (#well, #classic) ?"well is not available in classic mode";
      case (_, _) null;
    };
  };

  /// `?true` = p1 wins, `?false` = p2 wins, `null` = tie. Always the Well
  /// table — a strict superset of Classic, since `validate` already kept
  /// `#well` out of a Classic match.
  func p1Beats(a1 : Action, a2 : Action) : ?Bool {
    if (a1 == a2) return null;
    ?(
      switch (a1, a2) {
        case (#rock, #scissors) true;
        case (#paper, #rock) true;
        case (#paper, #well) true;
        case (#scissors, #paper) true;
        case (#well, #rock) true;
        case (#well, #scissors) true;
        case (_, _) false;
      }
    );
  };

  public func resolve(s : State, a1 : Action, a2 : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let (p1Score, p2Score) = switch (p1Beats(a1, a2)) {
      case (?true) (s.p1Score + 1, s.p2Score);
      case (?false) (s.p1Score, s.p2Score + 1);
      case null (s.p1Score, s.p2Score);
    };

    let verdict : ?TP.Verdict = if (p1Score >= WINS_NEEDED) ?#p1Wins else if (p2Score >= WINS_NEEDED) ?#p2Wins else null;

    {
      state = {
        p1Score;
        p2Score;
        lastRound = ?{ p1Action = a1; p2Action = a2 };
        variant = s.variant;
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
