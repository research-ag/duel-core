/// DotsAndBoxesRules — classic dots and boxes, as a pure `#turnBased`
/// module. The creator picks the board size at table time (boxes per
/// side); the state is the grid of pencil lines and the claimed boxes.
///
/// Seats: #p1 = Blue pencil (moves first), #p2 = Red pencil (display only).
///
/// Rules:
///   BOARD   an N x N grid of boxes drawn on (N+1) x (N+1) dots; N is the
///           table option `size` (2..8).
///   DRAW    the seat on turn draws ONE undrawn line between two
///           horizontally or vertically adjacent dots.
///   CLAIM   a box whose fourth side was just drawn belongs to the seat that
///           drew it (one line can close two boxes at once).
///   AGAIN   closing at least one box grants the same seat another turn;
///           drawing a line that closes nothing passes the turn.
///   END     once every line is drawn (every box is claimed) the seat with
///           more boxes wins; an equal count is a draw.
///
/// Line indexing (one flat `lines` array, horizontal lines first):
///   H = (N+1)*N horizontal lines: h(r, c) = r*N + c, for row r in 0..N
///       (dot rows) and column c in 0..N-1 — the line from dot (r, c) to
///       dot (r, c+1).
///   V = N*(N+1) vertical lines: v(r, c) = H + r*(N+1) + c, for row r in
///       0..N-1 and column c in 0..N (dot columns) — from dot (r, c) to
///       dot (r+1, c).
///   Box (r, c), index r*N + c, has sides h(r, c), h(r+1, c), v(r, c),
///   v(r, c+1).

import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";

import TP "mo:duel-game-core";

module {

  /// Served at `GET /semantics`: everything a frontend author who cannot
  /// see this file needs. No `"` or `\` inside.
  public let SEMANTICS : Text = "GAME: Dots and Boxes
MODE: turnBased (one action per step; a seat that closes a box moves again)
SEATS: p1 = Blue pencil (moves first), p2 = Red pencil
OPTIONS: type Options = record { size : nat };
  size = boxes per side, 2..8 (the page offers 3, 4, 5 and 6). The board
  has size x size boxes on (size+1) x (size+1) dots.

VIEW (Candid)
  type Seat = variant { p1; p2 };
  type View = record {
    size : nat;
    lines : vec opt Seat;
    boxes : vec opt Seat;
    toMove : Seat;
    lastLine : opt nat;
  };
  Nothing is hidden: both seats receive the whole state.
  size      boxes per side, N.
  lines     every line of the grid, 2*N*(N+1) entries: null = not drawn
            yet, opt p1 / opt p2 = drawn by that seat. Horizontal lines
            come first: h(r, c) = r*N + c for dot row r in 0..N and box
            column c in 0..N-1, the line from dot (r, c) to dot (r, c+1).
            Then vertical lines: v(r, c) = (N+1)*N + r*(N+1) + c for box
            row r in 0..N-1 and dot column c in 0..N, the line from dot
            (r, c) to dot (r+1, c).
  boxes     N*N entries, row-major (index r*N + c): null = not yet
            claimed, opt seat = claimed by that seat. Box (r, c) has
            sides h(r, c), h(r+1, c), v(r, c) and v(r, c+1).
  toMove    the seat whose action is expected next.
  lastLine  the index of the most recently drawn line, null before the
            first move. Who drew it is lines[lastLine].

ACTION (Candid)
  type Action = variant { draw : record { line : nat } };

RULES
  The seat on turn draws the line with index `line`.
  Rejected: line >= 2*N*(N+1) (off the board), or lines[line] is already
  drawn. The engine itself rejects an action from the seat not on turn.
  After the line is drawn, every box that now has all four sides drawn
  and was unclaimed is claimed by the mover (a line between two boxes
  can claim both). If at least one box was claimed, toMove stays with
  the mover; otherwise toMove switches to the other seat.

ENDINGS
  When every line is drawn (equivalently, every box is claimed): the
  seat with more boxes wins (p1Wins / p2Wins); equal counts are a draw.
  The game never ends earlier.

CLIENT NOTES
  Scores are not stored: count boxes per seat. The last move is
  lastLine; the boxes it closed are the one or two boxes adjacent to
  that line whose owner is lines[lastLine]. Legal moves are exactly the
  null entries of lines. The page also shows your own line the moment
  you click it, mirroring the rules locally. A chain of lines you know
  will each close a box can go in one duel_submit_moves call (lines in
  order); the engine applies them one by one and drops the rest once
  the turn passes.
";

  /// The raw decision only: which line to draw.
  public type Action = { #draw : { line : Nat } };

  /// null = not drawn; ?seat = drawn by that seat.
  public type Line = ?TP.Seat;

  public type State = {
    size : Nat;
    lines : [Line];
    boxes : [?TP.Seat];
    toMove : TP.Seat;
    lastLine : ?Nat;
  };

  /// Nothing is hidden: every seat sees the whole state.
  public type View = State;

  /// Boxes per side, picked by the table's creator.
  public type Options = { size : Nat };

  public let MIN_SIZE : Nat = 2;
  public let MAX_SIZE : Nat = 8;

  public func checkOptions(o : Options) : ?Text {
    if (o.size < MIN_SIZE or o.size > MAX_SIZE) ?"Board size must be 2 to 8 boxes per side." else null;
  };

  public func otherSeat(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public func sideName(seat : TP.Seat) : Text = switch (seat) {
    case (#p1) "Blue";
    case (#p2) "Red";
  };

  // ── geometry ──────────────────────────────────────────────────────────

  /// Horizontal lines on an N-board.
  public func hCount(n : Nat) : Nat = (n + 1) * n;

  /// Every line on an N-board.
  public func lineCount(n : Nat) : Nat = 2 * n * (n + 1);

  /// Index of the horizontal line from dot (r, c) to dot (r, c+1).
  public func hLine(n : Nat, r : Nat, c : Nat) : Nat = r * n + c;

  /// Index of the vertical line from dot (r, c) to dot (r+1, c).
  public func vLine(n : Nat, r : Nat, c : Nat) : Nat = hCount(n) + r * (n + 1) + c;

  /// Index of box (r, c).
  public func boxIndex(n : Nat, r : Nat, c : Nat) : Nat = r * n + c;

  /// The four sides of box `b`: top, bottom, left, right.
  public func boxSides(n : Nat, b : Nat) : [Nat] {
    let r = b / n;
    let c = b % n;
    [hLine(n, r, c), hLine(n, r + 1, c), vLine(n, r, c), vLine(n, r, c + 1)];
  };

  /// The one or two boxes a line borders.
  public func boxesOfLine(n : Nat, line : Nat) : [Nat] {
    let h = hCount(n);
    if (line < h) {
      // horizontal: row r in 0..n (dot row), column c in 0..n-1
      let r = line / n;
      let c = line % n;
      let above : [Nat] = if (r > 0) { [boxIndex(n, r - 1, c)] } else { [] };
      let below : [Nat] = if (r < n) { [boxIndex(n, r, c)] } else { [] };
      above.concat(below);
    } else {
      // vertical: row r in 0..n-1, column c in 0..n (dot column)
      let i : Nat = line - h;
      let r = i / (n + 1);
      let c = i % (n + 1);
      let left : [Nat] = if (c > 0) { [boxIndex(n, r, c - 1)] } else { [] };
      let right : [Nat] = if (c < n) { [boxIndex(n, r, c)] } else { [] };
      left.concat(right);
    };
  };

  public func isClosed(s : State, b : Nat) : Bool = boxSides(s.size, b).all(func(l) = s.lines[l] != null);

  public func boxesOf(s : State, seat : TP.Seat) : Nat = s.boxes.foldLeft<?TP.Seat, Nat>(0, func(acc, o) = if (o == ?seat) acc + 1 else acc);

  public func drawnCount(s : State) : Nat = s.lines.foldLeft<Line, Nat>(0, func(acc, l) = if (l != null) acc + 1 else acc);

  public func isFull(s : State) : Bool = drawnCount(s) == s.lines.size();

  // ── spec ──────────────────────────────────────────────────────────────

  public func init(o : Options, _ : TP.Rng) : State = {
    size = o.size;
    lines = Array.repeat<Line>(null, lineCount(o.size));
    boxes = Array.repeat<?TP.Seat>(null, o.size * o.size);
    toMove = #p1;
    lastLine = null;
  };

  public func toMove(s : State) : TP.Seat = s.toMove;

  public func view(s : State, _ : TP.Seat, _ : Bool) : View = s;

  /// Every undrawn line — exactly what `validate` accepts.
  public func legalActions(s : State, _seat : TP.Seat) : [Action] {
    s.lines.enumerate().toArray().filterMap<(Nat, Line), Action>(
      func((i, l)) = if (l == null) ?#draw { line = i } else null
    );
  };

  public func validate(s : State, _seat : TP.Seat, a : Action) : ?Text {
    switch (a) {
      case (#draw { line }) {
        if (line >= s.lines.size()) return ?"That line is off the board.";
        switch (s.lines[line]) {
          case null null;
          case (?_) ?"That line is already drawn.";
        };
      };
    };
  };

  /// Applies an already-validated draw: the line, the boxes it closes,
  /// whose turn it is next, and the verdict once the board is full.
  public func resolve(s : State, seat : TP.Seat, a : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let line = switch (a) { case (#draw d) d.line };
    let lines = s.lines.mapEntries<Line, Line>(func(cur, i) = if (i == line) ?seat else cur);
    let drawn = { s with lines };
    let closing = boxesOfLine(s.size, line).filter(
      func(b) = s.boxes[b] == null and isClosed(drawn, b)
    );
    let boxes = s.boxes.mapEntries<?TP.Seat, ?TP.Seat>(
      func(cur, b) = if (closing.any(func(x) = x == b)) ?seat else cur
    );
    let toMove = if (closing.size() > 0) seat else otherSeat(seat);
    let state : State = {
      size = s.size;
      lines;
      boxes;
      toMove;
      lastLine = ?line;
    };

    let verdict : ?TP.Verdict = if (isFull(state)) {
      let b1 = boxesOf(state, #p1);
      let b2 = boxesOf(state, #p2);
      if (b1 > b2) ?#p1Wins else if (b2 > b1) ?#p2Wins else ?#draw;
    } else null;

    { state; verdict };
  };

  /// One action of the seat on turn: checked, then applied.
  public func move(s : State, seat : TP.Seat, a : Action, _ : TP.Rng) : {
    #ok : { state : State; verdict : ?TP.Verdict };
    #err : Text;
  } = switch (validate(s, seat, a)) {
    case (?why) #err why;
    case null #ok(resolve(s, seat, a));
  };

  /// The functions the framework calls. Never stored by it: the host hands
  /// `spec` in on every call.
  public let spec : TP.Spec<State, Action, View, Options> = #turnBased {
    checkOptions;
    init;
    toMove;
    move;
    view;
  };
};
