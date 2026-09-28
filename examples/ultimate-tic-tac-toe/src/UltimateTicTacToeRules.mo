/// ═══════════════════════════════════════════════════════════════════════════
/// UltimateTicTacToeRules — Ultimate Tic-Tac-Toe, as a pure module.
/// https://en.wikipedia.org/wiki/Ultimate_tic-tac-toe
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = #alternating { init; validate; resolve }
///
/// Seats take turns in order (p1 moves first — see lib.mo's `Table.toMove`
/// doc); there is no "whose turn" flag in `State` because the engine
/// already tracks that. Seat mapping: #p1 = X, #p2 = O.
///
/// ── The board ──────────────────────────────────────────────────────────────
/// A 3x3 META-board of nine ordinary 3x3 LOCAL boards. `cells` is all 81
/// cells flattened, row-major within each local board
/// (`index = board*9 + cell`, `board`/`cell` each 0-8). `results` names
/// which seat (if either) has won each of the nine local boards, or that a
/// local board tied (filled with no line completed) — either way that
/// board is DECIDED and never accepts another placement.
///
/// ── Rules ──────────────────────────────────────────────────────────────────
///   PLACE   a seat places its own mark on any empty cell of a board that
///           is (a) not yet decided, and (b) either the one board
///           `activeBoard` names, or, when `activeBoard` is `null`, any
///           undecided board at all.
///   ROUTING the CELL POSITION just played (0-8, its position within its
///           own local board) picks out the SAME position among the nine
///           local boards as next turn's `activeBoard` — landing on the
///           local board's own center cell (4) sends the opponent to the
///           center local board (board 4), for instance. If that target
///           board is already decided, `activeBoard` instead becomes
///           `null` — the opponent's next placement may go in ANY
///           undecided board.
///   LOCAL WIN   three of a seat's own marks in a row, column, or diagonal
///               within one local board decides that board for that seat,
///               the instant the placing move completes the line.
///   LOCAL TIE   a local board fills with no line completed by either
///               seat — decided, but credited to neither.
///   MATCH WIN   three of a seat's own local-board wins in a row, column,
///               or diagonal on the META-board — i.e. `results` matching
///               one of `LINES` — wins the whole match for that seat.
///   DRAW        every local board is decided (won or tied) with no
///               meta-line completed by either seat.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";

module {

  // ────────────────────────── moves & state ──────────────────────────────

  /// Which seat (if either) has decided a local board — `#tie` if it
  /// filled with no line completed by either seat.
  public type BoardResult = { #p1; #p2; #tie };

  /// 81 cells, flattened: `index = board*9 + cell`, each 0-8, row-major
  /// within its own 3x3 local board. `?Seat` names whichever seat's mark
  /// occupies that cell, `null` if it's still empty.
  public type State = {
    cells : [?TP.Seat];
    results : [?BoardResult];
    /// `?b` — the next placement must land in local board `b` (it isn't
    /// decided yet, by construction — see `resolve`'s own routing note).
    /// `null` — free choice: any undecided board.
    activeBoard : ?Nat;
  };

  public type Action = { #place : { board : Nat; cell : Nat } };

  // ────────────────────────── board geometry ──────────────────────────────

  /// The eight 3-in-a-row lines of a 3x3 grid — reused identically for
  /// each local board's own win check (over `cells`) and for the
  /// meta-board's own win check (over `results`); both are the same 3x3
  /// geometry.
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

  func seatResult(seat : TP.Seat) : BoardResult = switch (seat) {
    case (#p1) #p1;
    case (#p2) #p2;
  };

  func setCell(cells : [?TP.Seat], i : Nat, v : ?TP.Seat) : [?TP.Seat] = cells.mapEntries<?TP.Seat, ?TP.Seat>(func(cur, j) = if (j == i) v else cur);

  func setResult(results : [?BoardResult], i : Nat, v : ?BoardResult) : [?BoardResult] = results.mapEntries<?BoardResult, ?BoardResult>(func(cur, j) = if (j == i) v else cur);

  func lineWonInBoard(cells : [?TP.Seat], board : Nat, seat : TP.Seat) : Bool {
    LINES.find<[Nat]>(func(line) = line.all<Nat>(func(i) = cells[board * 9 + i] == ?seat)) != null;
  };

  func boardFull(cells : [?TP.Seat], board : Nat) : Bool {
    var full = true;
    for (i in Nat.range(0, 9)) {
      if (cells[board * 9 + i] == null) full := false;
    };
    full;
  };

  func metaLineWonBy(results : [?BoardResult], seat : TP.Seat) : Bool {
    let want = ?seatResult(seat);
    LINES.find<[Nat]>(func(line) = line.all<Nat>(func(i) = results[i] == want)) != null;
  };

  func metaFull(results : [?BoardResult]) : Bool = results.all<?BoardResult>(func(r) = r != null);

  func openBoards(results : [?BoardResult]) : [Nat] {
    let out = List.empty<Nat>();
    for (b in Nat.range(0, 9)) {
      if (results[b] == null) out.add(b);
    };
    out.toArray();
  };

  public func init() : State = {
    cells = Array.repeat<?TP.Seat>(null, 81);
    results = Array.repeat<?BoardResult>(null, 9);
    activeBoard = null;
  };

  /// Every currently-legal placement — the same legality `validate`
  /// enforces, exported so a caller (a bot's own move selection, most
  /// notably — see `../../CLAUDE.md`'s "Canister players" note) doesn't
  /// have to re-derive "which boards are open, and which cells within them
  /// are empty" itself. An empty result means the whole meta-board is
  /// decided — the same condition `resolve`'s own draw check tests.
  public func legalActions(s : State, _seat : TP.Seat) : [Action] {
    let boards : [Nat] = switch (s.activeBoard) {
      case (?b) if (s.results[b] == null)[b] else openBoards(s.results);
      case null openBoards(s.results);
    };
    let out = List.empty<Action>();
    for (b in boards.values()) {
      for (c in Nat.range(0, 9)) {
        if (s.cells[b * 9 + c] == null) out.add(#place { board = b; cell = c });
      };
    };
    out.toArray();
  };

  // ────────────────────────── Spec: validate ───────────────────────────────

  /// null = legal. Called only for the seat currently on turn — the
  /// engine itself rejects an off-turn submission before this ever runs.
  public func validate(s : State, _seat : TP.Seat, a : Action) : ?Text {
    switch (a) {
      case (#place { board; cell }) {
        if (board >= 9 or cell >= 9) return ?"Off the board.";
        switch (s.results[board]) {
          case (?_) return ?"That local board is already decided.";
          case null {};
        };
        switch (s.activeBoard) {
          case (?b) if (b != board) return ?"Must play in the board sent by the opponent's last move.";
          case null {};
        };
        switch (s.cells[board * 9 + cell]) {
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
    let (board, cell) = switch (a) { case (#place p) (p.board, p.cell) };
    let cells = setCell(s.cells, board * 9 + cell, ?seat);

    let localResult : ?BoardResult = if (lineWonInBoard(cells, board, seat)) ?seatResult(seat) else if (boardFull(cells, board)) ?#tie else null;

    let results = switch (localResult) {
      case (?r) setResult(s.results, board, ?r);
      case null s.results;
    };

    // Route the opponent to the local board matching the cell position
    // just played — unless that board is already decided, in which case
    // their next placement is a free choice among whatever's still open.
    let activeBoard : ?Nat = if (results[cell] == null) ?cell else null;

    let verdict : ?TP.Verdict = if (metaLineWonBy(results, seat)) {
      ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
    } else if (metaFull(results)) ?#draw else null;

    { state = { cells; results; activeBoard }; verdict };
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
