/// ═══════════════════════════════════════════════════════════════════════════
/// RockPaperScissorsWellRules — rock-paper-scissors-well (a 4-symbol
/// expansion of the classic hand game), as a pure module.
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
///   A fourth symbol, WELL, joins rock/paper/scissors. Each round both
///   players secretly pick one of the four, revealed simultaneously:
///     - Scissors beats Paper.
///     - Paper beats Rock and Well (it covers both).
///     - Rock beats Scissors.
///     - Well beats Rock and Scissors (both fall into the well).
///   Every distinct pair of symbols has exactly one winner (this is a
///   complete tournament over 4 symbols, not a symmetric one — Paper and
///   Well each beat two symbols and lose to one, Rock and Scissors each
///   beat one and lose to two). The same pick from both sides is a tied
///   round — nobody scores. First to WINS_NEEDED round wins takes the
///   match.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";

module {

  // ────────────────────────── moves & state ──────────────────────────────

  public type Action = { #rock; #paper; #scissors; #well };

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

  /// Every pick is always legal — this game has no resource or board
  /// state that could make a pick illegal.
  public func validate(_s : State, _seat : TP.Seat, _a : Action) : ?Text = null;

  // ────────────────────────── Spec: resolve ────────────────────────────────

  /// `?true` = p1's pick beats p2's; `?false` = p2's beats p1's; `null` =
  /// tie. Every one of the six distinct pairs has exactly one winner (see
  /// this module's own doc header) — there is no symmetric "adjacent
  /// beats adjacent" shortcut the way plain rock-paper-scissors has, so
  /// each pair is spelled out explicitly.
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
