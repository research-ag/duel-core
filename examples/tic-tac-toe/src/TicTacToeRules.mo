/// TicTacToeRules — standard 3x3 tic-tac-toe, as a pure `#turnBased`
/// module. #p1 = X (first), #p2 = O. 9 cells, row-major.
///
/// Rules:
///   PLACE  a seat places its own mark on any EMPTY cell.
///   WIN    three of a seat's marks in a row, column, or diagonal.
///   DRAW   the board fills with no line completed.

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: Tic-tac-toe
MODE: turnBased (one action per turn, seats alternate)
SEATS: p1 = X (moves first), p2 = O
OPTIONS: none (type Options = record {})

STATE (Candid)
  type Seat = variant { p1; p2 };
  type State = record { board : vec opt Seat };
  board has 9 cells, row-major: index = row*3 + col. null = empty,
  opt p1 = X, opt p2 = O.

ACTION (Candid)
  type Action = variant { place : record { at : nat } };

RULES
  The seat on turn places its mark on any empty cell (at in 0..8).
  Rejected: at >= 9, or the cell is taken.

ENDINGS
  Three of one seat's marks in a row, column or diagonal: that seat wins.
  Full board with no line: draw.

CLIENT NOTES
  State carries no move history; find the opponent's last mark by
  diffing two consecutive boards.
";

  public type Board = [?TP.Seat];

  public type Action = { #place : { at : Nat } };

  public type State = { board : Board };

  /// Nothing is hidden: every seat sees the whole state.
  public type View = State;

  /// No table options.
  public type Options = {};

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

  public func checkOptions(_ : Options) : ?Text = null;

  public func init(_ : Options, _ : TP.Rng) : State = { board = emptyBoard() };

  /// X moves first; marks alternate, so the count of marks says whose
  /// turn it is.
  public func toMove(self : State) : TP.Seat {
    let marks = self.board.filter(func(c : ?TP.Seat) : Bool = c != null).size();
    if (marks % 2 == 0) #p1 else #p2;
  };

  public func view(self : State, _ : TP.Seat, _ : Bool) : View = self;

  func lineWonBy(board : Board, seat : TP.Seat) : Bool {
    LINES.find<[Nat]>(
      func(line) = line.all<Nat>(func(i) = board[i] == ?seat)
    ) != null;
  };

  func isFull(board : Board) : Bool = board.all<?TP.Seat>(func(cell) = cell != null);

  /// Every empty cell — exactly what `validate` accepts; seat-independent.
  public func legalActions(s : State, _seat : TP.Seat) : [Action] {
    let out = List.empty<Action>();
    for (i in Nat.range(0, CELLS)) {
      if (s.board[i] == null) out.add(#place { at = i });
    };
    out.toArray();
  };

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
