/// UltimateTicTacToeRules — https://en.wikipedia.org/wiki/Ultimate_tic-tac-toe
/// as a pure `#turnBased` module. #p1 = X (first), #p2 = O.
///
/// A 3x3 META-board of nine 3x3 LOCAL boards. `cells` is all 81 cells
/// flattened (`index = board*9 + cell`); `results` says which seat won
/// each local board, or that it tied — either way it is DECIDED.
///
/// Rules:
///   PLACE   a seat places its mark on an empty cell of an undecided board
///           that is either the one `activeBoard` names or, when
///           `activeBoard` is `null`, any undecided board.
///   ROUTING the CELL POSITION just played picks the same position among
///           the local boards as next turn's `activeBoard`; if that board
///           is decided, `activeBoard` becomes `null` (free choice).
///   LOCAL WIN   three in a line within one local board decides it.
///   LOCAL TIE   a full local board with no line — decided for neither.
///   MATCH WIN   three of a seat's local wins in a meta-line.
///   DRAW        every local board decided with no meta-line.

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: Ultimate tic-tac-toe
MODE: turnBased (one action per turn, seats alternate)
SEATS: p1 = X (moves first), p2 = O
OPTIONS: none (type Options = record {})

STATE (Candid)
  type Seat = variant { p1; p2 };
  type BoardResult = variant { p1; p2; tie };
  type State = record {
    cells : vec opt Seat;
    results : vec opt BoardResult;
    activeBoard : opt nat;
  };
  A 3x3 meta-board of nine 3x3 local boards. cells has 81 entries:
  index = board*9 + cell, both 0..8 row-major. results has 9 entries:
  null = that local board is still open, otherwise who won it or tie.
  activeBoard = opt b: the next placement must land in local board b;
  null: any open local board.

ACTION (Candid)
  type Action = variant { place : record { board : nat; cell : nat } };

RULES
  The seat on turn places its mark on an empty cell of an open local
  board: the one activeBoard names, or any open one when it is null.
  The cell position just played names the next activeBoard; if that
  local board is already decided, activeBoard becomes null.
  Three in a line inside a local board wins it; a full local board with
  no line is a tie. Either way it is decided and takes no more marks.
  Rejected: board or cell >= 9, a decided local board, a board other
  than activeBoard, a taken cell.

ENDINGS
  Three local boards won by one seat in a meta-line: that seat wins.
  Every local board decided with no meta-line: draw.

CLIENT NOTES
  State carries no move history; find the opponent's last mark by
  diffing two consecutive cells arrays.
";

  public type BoardResult = { #p1; #p2; #tie };

  public type State = {
    cells : [?TP.Seat];
    results : [?BoardResult];
    /// `?b` — the next placement must land in board `b`. `null` — free.
    activeBoard : ?Nat;
  };

  public type Action = { #place : { board : Nat; cell : Nat } };

  /// Shared by the local and meta win checks.
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

  /// Nothing is hidden: every seat sees the whole state.
  public type View = State;

  /// No table options.
  public type Options = {};

  public func checkOptions(_ : Options) : ?Text = null;

  public func init(_ : Options, _ : TP.Rng) : State = {
    cells = Array.repeat<?TP.Seat>(null, 81);
    results = Array.repeat<?BoardResult>(null, 9);
    activeBoard = null;
  };

  /// Every legal placement — exactly what `validate` accepts.
  public func legalActions(s : State, _seat : TP.Seat) : [Action] {
    let boards : [Nat] = switch (s.activeBoard) {
      case (?b) if (s.results[b] == null) { [b] } else { openBoards(s.results) };
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

    // Routed against the FRESH results, so a board decided by this very
    // move counts as decided.
    let activeBoard : ?Nat = if (results[cell] == null) ?cell else null;

    let verdict : ?TP.Verdict = if (metaLineWonBy(results, seat)) {
      ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
    } else if (metaFull(results)) ?#draw else null;

    { state = { cells; results; activeBoard }; verdict };
  };

  /// Whose action the game is waiting for.
  public func toMove(self : State) : TP.Seat = if (self.cells.filter(func(c : ?TP.Seat) : Bool = c != null).size() % 2 == 0) #p1 else #p2;

  public func view(self : State, _ : TP.Seat, _ : Bool) : View = self;

  /// One action of the seat on turn: checked, then applied.
  public func move(self : State, seat : TP.Seat, a : Action, _ : TP.Rng) : {
    #ok : { state : State; verdict : ?TP.Verdict };
    #err : Text;
  } = switch (validate(self, seat, a)) {
    case (?why) #err why;
    case null #ok(resolve(self, seat, a));
  };

  public let spec : TP.Spec<State, Action, View, Options> = #turnBased {
    checkOptions;
    init;
    toMove;
    move;
    view;
  };
};
