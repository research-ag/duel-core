/// DotsAndBoxesRules — classic dots and boxes, as a pure `#turnBased`
/// module. The creator picks the board size at table time (boxes per
/// side); the state is the grid of pencil lines and the claimed boxes.
///
/// Seats: #p1 = Blue pencil (moves first), #p2 = Red pencil (display only).
///
/// Rules:
///   BOARD   an N x N grid of boxes drawn on (N+1) x (N+1) dots; N is the
///           table option `size` (2..8).
///   DRAW    a line joins two horizontally or vertically adjacent dots.
///   CLAIM   a box whose fourth side was just drawn belongs to the seat that
///           drew it (one line can close two boxes at once).
///   AGAIN   closing at least one box makes the same seat draw again;
///           drawing a line that closes nothing ends the turn.
///   TURN    one action is a whole turn: every line that closed a box, in
///           order, then the line that closed nothing (or the line that
///           filled the board). Seats strictly alternate.
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
import Nat "mo:core/Nat";

import TP "mo:duel-game-core";

module {

  /// Served at `GET /semantics`: everything a frontend author who cannot
  /// see this file needs. No `"` or `\` inside.
  public let SEMANTICS : Text = "GAME: Dots and Boxes
MODE: turnBased (one action = one whole turn; seats alternate)
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
    lastTurn : vec nat;
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
  lastTurn  the lines of the most recent turn, in the order drawn; empty
            before the first move. Who drew them is lines[lastTurn[0]];
            the other seat is on turn (p1 when lastTurn is empty), as
            the engine's in-game view (toMove) also says.

ACTION (Candid)
  type Action = variant { draw : record { lines : vec nat } };

RULES
  An action is the mover's whole turn: the lines in `lines` are drawn
  one after another. After each line, every box that now has all four
  sides drawn and was unclaimed is claimed by the mover (a line between
  two boxes can claim both). Every line but the last must claim at
  least one box; the last must claim none, unless it fills the board.
  Rejected: an empty `lines`; a line >= 2*N*(N+1) (off the board) or
  already drawn (an earlier line of the same turn included); a line
  other than the last that claims nothing; a last line that claims a box
  while undrawn lines remain. The engine itself rejects an action from
  the seat not on turn. After the turn, the other seat is on turn.

ENDINGS
  When every line is drawn (equivalently, every box is claimed): the
  seat with more boxes wins (p1Wins / p2Wins); equal counts are a draw.
  The game never ends earlier.

CLIENT NOTES
  Scores are not stored: count boxes per seat. The opponent's last turn
  is lastTurn, to be replayed in order. Every move is deterministic, so
  a page builds the turn locally: a click on a line that closes a box
  draws it at once and waits for the next click; a click on a line that
  closes nothing (or fills the board) sends every line of the turn as
  one action.
";

  /// A whole turn: the lines in the order drawn.
  public type Action = { #draw : { lines : [Nat] } };

  /// null = not drawn; ?seat = drawn by that seat.
  public type Line = ?TP.Seat;

  public type State = {
    size : Nat;
    lines : [Line];
    boxes : [?TP.Seat];
    lastTurn : [Nat];
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
    lastTurn = [];
  };

  /// Seats alternate: the one that did not draw the last turn.
  public func toMove(s : State) : TP.Seat {
    if (s.lastTurn.size() == 0) return #p1;
    switch (s.lines[s.lastTurn[0]]) {
      case (?seat) otherSeat(seat);
      case null #p1;
    };
  };

  public func view(s : State, _ : TP.Seat, _ : Bool) : View = s;

  /// Draws one undrawn `line` for `seat` and claims the boxes it closes;
  /// `lastTurn` stays as it is.
  public func drawLine(s : State, seat : TP.Seat, line : Nat) : {
    state : State;
    closed : Bool;
  } {
    let lines = s.lines.mapEntries<Line, Line>(func(cur, i) = if (i == line) ?seat else cur);
    let drawn = { s with lines };
    let closing = boxesOfLine(s.size, line).filter(
      func(b) = s.boxes[b] == null and isClosed(drawn, b)
    );
    let boxes = s.boxes.mapEntries<?TP.Seat, ?TP.Seat>(
      func(cur, b) = if (closing.any(func(x) = x == b)) ?seat else cur
    );
    { state = { drawn with boxes }; closed = closing.size() > 0 };
  };

  /// One whole turn of the seat on turn: checked line by line, then the
  /// turn passes, with the verdict once the board is full.
  public func move(s : State, seat : TP.Seat, a : Action, _ : TP.Rng) : {
    #ok : { state : State; verdict : ?TP.Verdict };
    #err : Text;
  } {
    let turn = switch (a) { case (#draw d) d.lines };
    if (turn.size() == 0) return #err "Draw at least one line.";
    var cur = s;
    for ((k, line) in turn.enumerate()) {
      if (line >= cur.lines.size()) return #err "That line is off the board.";
      if (cur.lines[line] != null) return #err "That line is already drawn.";
      let r = drawLine(cur, seat, line);
      cur := r.state;
      if (k + 1 < turn.size() and not r.closed) return #err "Only a line that closes a box draws again.";
      if (k + 1 == turn.size() and r.closed and not isFull(cur)) return #err "A closed box draws again: the turn needs another line.";
    };
    let state = { cur with lastTurn = turn };
    let verdict : ?TP.Verdict = if (isFull(state)) {
      let b1 = boxesOf(state, #p1);
      let b2 = boxesOf(state, #p2);
      if (b1 > b2) ?#p1Wins else if (b2 > b1) ?#p2Wins else ?#draw;
    } else null;
    #ok { state; verdict };
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
