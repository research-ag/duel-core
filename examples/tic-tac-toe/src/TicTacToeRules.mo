/// ═══════════════════════════════════════════════════════════════════════════
/// TicTacToeRules — standard 3x3 tic-tac-toe, as a pure module.
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = #alternating { init; validate; resolve }
///
/// Seats take turns in order (p1 moves first — see lib.mo's `Table.toMove`
/// doc); there is no "whose turn" flag in `State` because the engine
/// already tracks that. Seat mapping: #p1 = X, #p2 = O. The board is 9
/// cells, row-major (`index = row*3 + col`).
///
/// ── Rules ──────────────────────────────────────────────────────────────────
///   PLACE  a seat places its own mark on any EMPTY cell. There is no
///          other move.
///   WIN    three of a seat's own marks in a row, column, or diagonal
///          ends the match for that seat, the instant the placing move
///          completes the line.
///   DRAW   the board fills with no line completed by either seat.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";

module {

  // ────────────────────────── moves & state ──────────────────────────────

  /// 9 cells, row-major (`index = row*3 + col`); `?Seat` names whichever
  /// seat's mark occupies that cell, `null` if it's still empty.
  public type Board = [?TP.Seat];

  public type Action = { #place : { at : Nat } };

  public type State = { board : Board };

  // ────────────────────────── board geometry ──────────────────────────────

  let SIZE : Nat = 3;
  let CELLS : Nat = 9;

  let LINES : [[Nat]] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8], // rows
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8], // columns
    [0, 4, 8],
    [2, 4, 6], // diagonals
  ];

  func setAt(board : Board, i : Nat, v : ?TP.Seat) : Board = board.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == i) v else cur);

  func emptyBoard() : Board = Array.repeat<?TP.Seat>(null, CELLS);

  public func init() : State = { board = emptyBoard() };

  func lineWonBy(board : Board, seat : TP.Seat) : Bool {
    LINES.find<[Nat]>(
      func(line) = line.all<Nat>(func(i) = board[i] == ?seat)
    ) != null;
  };

  func isFull(board : Board) : Bool = board.all<?TP.Seat>(func(cell) = cell != null);

  /// Every empty cell, as the one legal `Action` for it — the same
  /// legality `validate` enforces, exported so a caller (a bot's own move
  /// selection, most notably — see `../../CLAUDE.md`'s "Canister
  /// players" note) doesn't have to re-derive "which cells are empty"
  /// itself. Legality here doesn't depend on `seat` at all (either seat
  /// may place on any empty cell), unlike checkers' own `legalActions`;
  /// the parameter still exists so a caller's own signature matches that
  /// convention. An empty result means the board is full — the same
  /// condition `resolve`'s own draw check tests.
  public func legalActions(s : State, _seat : TP.Seat) : [Action] {
    let out = List.empty<Action>();
    for (i in Nat.range(0, CELLS)) {
      if (s.board[i] == null) out.add(#place { at = i });
    };
    out.toArray();
  };

  // ────────────────────────── Spec: validate ───────────────────────────────

  /// null = legal. Called only for the seat currently on turn — the
  /// engine itself rejects an off-turn submission before this ever runs.
  public func validate(s : State, _seat : TP.Seat, a : Action) : ?Text {
    switch (a) {
      case (#place { at }) {
        if (at >= CELLS) return ?"Off the board.";
        switch (s.board[at]) {
          case null null;
          case (?_) ?"That square is already taken.";
        };
      };
    };
  };

  // ────────────────────────── Spec: resolve ────────────────────────────────

  /// The on-turn seat's move is already validated. Pure: State in, new
  /// State + optional verdict out.
  public func resolve(s : State, seat : TP.Seat, a : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let at = switch (a) { case (#place p) p.at };
    let board = setAt(s.board, at, ?seat);

    let verdict : ?TP.Verdict = if (lineWonBy(board, seat)) {
      ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
    } else if (isFull(board)) ?#draw else null;

    { state = { board }; verdict };
  };

  // ────────────────────────── the plug ─────────────────────────────────────

  /// Hand this to every duel-game-core engine call. Built fresh per call —
  /// function values are never stored, so upgrades stay trivial.
  /// `#alternating`: X and O take turns, one placement per submission.
  public func spec() : TP.Spec<State, Action> = #alternating {
    init;
    validate;
    resolve;
  };
};
