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
///   The same pick from both sides is a tied round. First to `winsNeeded`
///   round wins takes the match.

import TP "mo:duel-game-core";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: Rock-paper-scissors
MODE: simultaneous
SEATS: p1 and p2 are symmetric
OPTIONS (picked by the table's creator)
  type Options = record { variant : Variant; winsNeeded : nat };
  variant: classic (rock, paper, scissors) or well (adds a fourth
  symbol, well). winsNeeded: round wins that take the match, 1 to 9.

STATE (Candid)
  type Action = variant { rock; paper; scissors; well };
  type Round = record { p1Action : Action; p2Action : Action };
  type Variant = variant { classic; well };
  type State = record {
    p1Score : nat;
    p2Score : nat;
    lastRound : opt Round;
    variant : Variant;
    winsNeeded : nat;
  };
  lastRound is the round just resolved, null before the first.

ACTION (Candid)
  type Action = variant { rock; paper; scissors; well };

RULES
  Each round both seats secretly pick a symbol.
  Scissors beats paper. Paper beats rock. Rock beats scissors.
  In the well variant: well beats rock and scissors, paper beats well.
  The same pick from both seats is a tied round and scores nobody;
  otherwise the winner's score goes up by 1.
  Rejected: well in the classic variant.

ENDINGS
  First seat to winsNeeded round wins takes the match. There is no draw.

CLIENT NOTES
  Offer the well button only when state.variant is well.
";

  public type Variant = { #classic; #well };

  /// The table's options: which symbols, and how many round wins take
  /// the match.
  public type Options = { variant : Variant; winsNeeded : Nat };

  public func checkOptions(o : Options) : ?Text {
    if (o.winsNeeded < 1 or o.winsNeeded > 9) ?"Wins needed must be 1 to 9." else null;
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
    winsNeeded : Nat;
  };

  /// Nothing is hidden: every seat sees the whole state.
  public type View = State;

  public func init(o : Options, _ : TP.Rng) : State = {
    p1Score = 0;
    p2Score = 0;
    lastRound = null;
    variant = o.variant;
    winsNeeded = o.winsNeeded;
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

    let verdict : ?TP.Verdict = if (p1Score >= s.winsNeeded) ?#p1Wins else if (p2Score >= s.winsNeeded) ?#p2Wins else null;

    {
      state = {
        p1Score;
        p2Score;
        lastRound = ?{ p1Action = a1; p2Action = a2 };
        variant = s.variant;
        winsNeeded = s.winsNeeded;
      };
      verdict;
    };
  };

  public func view(self : State, _ : TP.Seat, _ : Bool) : View = self;

  /// Both seats' actions, applied together once both are in.
  public func resolveRound(self : State, a1 : Action, a2 : Action, _ : TP.Rng) : {
    state : State;
    verdict : ?TP.Verdict;
  } = resolve(self, a1, a2);

  public let spec : TP.Spec<State, Action, View, Options> = #simultaneous {
    checkOptions;
    init;
    validate;
    resolve = resolveRound;
    view;
  };
};
