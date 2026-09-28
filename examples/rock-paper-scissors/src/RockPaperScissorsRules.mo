/// ═══════════════════════════════════════════════════════════════════════════
/// RockPaperScissorsRules — classic rock-paper-scissors, as a pure module.
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = #simultaneous { init; validate; resolve }
///
/// Seat mapping: #p1/#p2 (plain "Player 1"/"Player 2" — the rules name
/// neither side).
///
/// ── Rules ──────────────────────────────────────────────────────────────────
///   Each round both players secretly pick ROCK, PAPER, or SCISSORS,
///   revealed simultaneously. Scissors beats Paper, Paper beats Rock, Rock
///   beats Scissors; the same pick from both sides is a tied round —
///   nobody scores. First to WINS_NEEDED round wins takes the match.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";

module {

  // ────────────────────────── moves & state ──────────────────────────────

  public type Action = { #rock; #paper; #scissors };

  public type Round = {
    p1Action : Action;
    p2Action : Action;
  };

  public type State = {
    p1Score : Nat;
    p2Score : Nat;
    lastRound : ?Round;
  };

  // ────────────────────────── tuning constants ────────────────────────────

  let WINS_NEEDED : Nat = 3;

  // ────────────────────────── Spec: init ───────────────────────────────────

  public func init() : State = { p1Score = 0; p2Score = 0; lastRound = null };

  // ────────────────────────── Spec: validate ───────────────────────────────

  /// Every pick is always legal — rock-paper-scissors has no resource or
  /// board state that could make a move illegal.
  public func validate(_s : State, _seat : TP.Seat, _a : Action) : ?Text = null;

  // ────────────────────────── Spec: resolve ────────────────────────────────

  /// `?true` = p1 beats p2's pick; `?false` = p2 beats p1's; `null` = tie.
  func p1Beats(a1 : Action, a2 : Action) : ?Bool {
    if (a1 == a2) return null;
    ?(
      switch (a1, a2) {
        case (#rock, #scissors) true;
        case (#scissors, #paper) true;
        case (#paper, #rock) true;
        case (_, _) false;
      }
    );
  };

  /// Both moves are in (already validated). Pure: State in, new State +
  /// optional verdict out.
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
      };
      verdict;
    };
  };

  // ────────────────────────── the plug ─────────────────────────────────────

  /// Hand this to every duel-game-core engine call. Built fresh per call —
  /// function values are never stored, so upgrades stay trivial.
  /// `#simultaneous`: both seats pick every round.
  public func spec() : TP.Spec<State, Action> = #simultaneous {
    init;
    validate;
    resolve;
  };
};
