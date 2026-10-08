/// CheckersRules — standard English draughts, as a pure `#alternating`
/// module. #p1 = Black (rows 5–7, moving toward row 0), #p2 = Red (rows
/// 0–2, moving toward row 7). 8x8, row-major (`index = row*8 + col`), dark
/// squares (`(row+col)` odd) only.
///
/// Rules:
///   MOVE  a man moves one square diagonally FORWARD onto an empty square;
///         a king moves one square diagonally in ANY direction.
///   JUMP  a man captures by jumping an adjacent enemy piece — forward
///         only — onto the empty square beyond; a king in any direction.
///         Capturing is MANDATORY: if the seat to move has any capture,
///         only a #jump is legal. A single #jump carries the WHOLE chain
///         (every landing square), and the chain must be maximal.
///   KING  a man reaching the far row is promoted once its full move
///         resolves and ends there.
///   WIN   a seat with no legal move on their turn loses.
///
/// Deliberate simplifications:
///   - Mandatory capture only requires SOME capture, not the longest.
///   - No mid-chain promotion; only the final landing square is checked.
///   - No draw condition.

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";

module {

  /// Served at `/semantics`; see the backend README, "Semantics over HTTP".
  public let SEMANTICS : Text = "GAME: Checkers (English draughts)
MODE: alternating
SEATS: p1 = Black (moves first), p2 = Red
VARIANTS: none (the table variant text is ignored)

STATE (Candid)
  type Piece = variant { manP1; manP2; kingP1; kingP2 };
  type State = record { board : vec opt Piece };
  board has 64 squares, row-major: index = row*8 + col. Only dark
  squares, (row + col) odd, are ever used. p1 starts on rows 5..7 and
  moves toward row 0; p2 starts on rows 0..2 and moves toward row 7.

ACTION (Candid)
  type Action = variant {
    move : record { from : nat; to : nat };
    jump : record { path : vec nat };
  };
  move: one non-capturing step. jump: path[0] is the origin square,
  then every landing square of the whole capture chain in order.

RULES
  A man steps one square diagonally forward onto an empty square; a
  king steps one square diagonally in any direction.
  A man captures by jumping an adjacent enemy piece, forward only, onto
  the empty square beyond; a king captures in any direction.
  Capturing is mandatory: if the seat on turn has any capture, only a
  jump is legal. Any capture will do, not necessarily the longest, but
  the chosen chain must be continued until the piece has no further
  capture.
  A man whose move ends on the far row becomes a king. There is no
  promotion in the middle of a chain.

ENDINGS
  A seat with no legal action on its turn loses. No draw.

CLIENT NOTES
  State carries no move history; find the opponent's last move by
  diffing two consecutive boards.
";

  public type Piece = { #manP1; #manP2; #kingP1; #kingP2 };

  public type Board = [?Piece];

  public type Action = {
    #move : { from : Nat; to : Nat };
    #jump : { path : [Nat] };
  };

  public type State = { board : Board };

  let SIZE : Nat = 8;
  let SQUARES : Nat = 64;

  let DIAGS : [(Int, Int)] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

  func rowOf(i : Nat) : Nat = i / SIZE;
  func colOf(i : Nat) : Nat = i % SIZE;
  func inBoard(i : Nat) : Bool = i < SQUARES;
  func isPlayable(i : Nat) : Bool = (rowOf(i) + colOf(i)) % 2 == 1;

  func ownerOf(p : Piece) : TP.Seat = switch p {
    case (#manP1) #p1;
    case (#kingP1) #p1;
    case (#manP2) #p2;
    case (#kingP2) #p2;
  };
  func isKingPiece(p : Piece) : Bool = switch p {
    case (#kingP1) true;
    case (#kingP2) true;
    case (#manP1) false;
    case (#manP2) false;
  };
  func promote(p : Piece) : Piece = switch p {
    case (#manP1) #kingP1;
    case (#manP2) #kingP2;
    case (other) other;
  };
  func otherSeat(seat : TP.Seat) : TP.Seat = switch seat {
    case (#p1) #p2;
    case (#p2) #p1;
  };
  func forwardDelta(seat : TP.Seat) : Int = switch seat {
    case (#p1) -1;
    case (#p2) 1;
  };
  func backRowFor(seat : TP.Seat) : Nat = switch seat {
    case (#p1) 0;
    case (#p2) SIZE - 1;
  };

  func buildBoard(f : Nat -> ?Piece) : Board = Array.repeat<()>((), SQUARES).mapEntries<(), ?Piece>(func(_, i) = f(i));

  func setAt(board : Board, i : Nat, v : ?Piece) : Board = board.mapEntries<?Piece, ?Piece>(func(cur, j) = if (j == i) v else cur);

  func startBoard() : Board = buildBoard(
    func(i) {
      if (not isPlayable(i)) null else {
        let r = rowOf(i);
        if (r <= 2) ?#manP2 else if (r >= 5) ?#manP1 else null;
      };
    }
  );

  public func init(_variant : Text) : State = { board = startBoard() };

  /// Legal one-square, non-capturing destinations for `piece` at `i`.
  func stepTargets(board : Board, piece : Piece, i : Nat) : [Nat] {
    let r = rowOf(i).toInt();
    let c = colOf(i).toInt();
    let king = isKingPiece(piece);
    let owner = ownerOf(piece);
    DIAGS.filterMap<(Int, Int), Nat>(
      func((dr, dc)) {
        if (not king and dr != forwardDelta(owner)) return null;
        let nr = r + dr;
        let nc = c + dc;
        if (nr < 0 or nr >= 8 or nc < 0 or nc >= 8) return null;
        let dest = nr.toNat() * SIZE + nc.toNat();
        switch (board[dest]) {
          case null ?dest;
          case (?_) null;
        };
      }
    );
  };

  /// Legal one-leg captures for `piece` at `i`: `(captured, landing)`.
  func jumpTargets(board : Board, piece : Piece, i : Nat) : [(Nat, Nat)] {
    let r = rowOf(i).toInt();
    let c = colOf(i).toInt();
    let king = isKingPiece(piece);
    let owner = ownerOf(piece);
    DIAGS.filterMap<(Int, Int), (Nat, Nat)>(
      func((dr, dc)) {
        if (not king and dr != forwardDelta(owner)) return null;
        let mr = r + dr;
        let mc = c + dc;
        let lr = r + dr * 2;
        let lc = c + dc * 2;
        if (lr < 0 or lr >= 8 or lc < 0 or lc >= 8) return null;
        let mid = mr.toNat() * SIZE + mc.toNat();
        let land = lr.toNat() * SIZE + lc.toNat();
        switch (board[land]) {
          case (?_) return null;
          case null {};
        };
        switch (board[mid]) {
          case (?victim) if (ownerOf(victim) != owner) ?(mid, land) else null;
          case null null;
        };
      }
    );
  };

  func seatHasCapture(board : Board, seat : TP.Seat) : Bool {
    for (i in Nat.range(0, SQUARES)) {
      switch (board[i]) {
        case (?p) if (ownerOf(p) == seat and jumpTargets(board, p, i).size() > 0) return true;
        case null {};
      };
    };
    false;
  };

  func seatHasAnyLegalAction(board : Board, seat : TP.Seat) : Bool {
    if (seatHasCapture(board, seat)) return true;
    for (i in Nat.range(0, SQUARES)) {
      switch (board[i]) {
        case (?p) if (ownerOf(p) == seat and stepTargets(board, p, i).size() > 0) return true;
        case null {};
      };
    };
    false;
  };

  /// Every MAXIMAL capture chain from `origin`, as full paths.
  func captureChainsFrom(board : Board, piece : Piece, origin : Nat) : [[Nat]] {
    let results = List.empty<[Nat]>();
    func go(board : Board, cur : Nat, path : List.List<Nat>) {
      let legs = jumpTargets(board, piece, cur);
      if (legs.size() == 0) {
        results.add(path.toArray());
      } else {
        for ((mid, land) in legs.values()) {
          let board2 = setAt(setAt(setAt(board, mid, null), cur, null), land, ?piece);
          let path2 = path.clone();
          path2.add(land);
          go(board2, land, path2);
        };
      };
    };
    let path0 = List.empty<Nat>();
    path0.add(origin);
    go(board, origin, path0);
    results.toArray();
  };

  /// Every legal `Action` for `seat` — exactly what `validate` accepts.
  /// Empty means no legal action at all (the losing condition).
  public func legalActions(s : State, seat : TP.Seat) : [Action] {
    let out = List.empty<Action>();
    if (seatHasCapture(s.board, seat)) {
      for (i in Nat.range(0, SQUARES)) {
        switch (s.board[i]) {
          // Only a piece that itself can capture contributes chains.
          case (?p) if (ownerOf(p) == seat and jumpTargets(s.board, p, i).size() > 0) {
            for (path in captureChainsFrom(s.board, p, i).values()) {
              out.add(#jump { path });
            };
          };
          case _ {};
        };
      };
    } else {
      for (i in Nat.range(0, SQUARES)) {
        switch (s.board[i]) {
          case (?p) if (ownerOf(p) == seat) {
            for (to in stepTargets(s.board, p, i).values()) {
              out.add(#move { from = i; to });
            };
          };
          case null {};
        };
      };
    };
    out.toArray();
  };

  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    switch (a) {

      case (#move { from; to }) {
        if (not inBoard(from) or not inBoard(to)) return ?"Off the board.";
        let piece = switch (s.board[from]) {
          case (?p) if (ownerOf(p) == seat) p else return ?"That's not your piece.";
          case null return ?"There's no piece there.";
        };
        if (seatHasCapture(s.board, seat)) {
          return ?"A capture is available and must be taken.";
        };
        if (not stepTargets(s.board, piece, from).contains<Nat>(Nat.equal, to)) {
          return ?"That's not a legal move for this piece.";
        };
        null;
      };

      case (#jump { path }) {
        if (path.size() < 2) return ?"A capture needs at least two squares.";
        for (idx in path.values()) {
          if (not inBoard(idx)) return ?"Off the board.";
        };
        let piece = switch (s.board[path[0]]) {
          case (?p) if (ownerOf(p) == seat) p else return ?"That's not your piece.";
          case null return ?"There's no piece there.";
        };

        // Walk the chain against a board updated after each leg.
        let captured = List.empty<Nat>();
        var board = s.board;
        var cur = path[0];
        var k = 1;
        label chain loop {
          if (k >= path.size()) break chain;
          let next = path[k];
          let leg = jumpTargets(board, piece, cur).find<(Nat, Nat)>(
            func((mid, land)) = land == next and not captured.contains<Nat>(Nat.equal, mid)
          );
          switch (leg) {
            case (?(mid, _)) {
              captured.add(mid);
              board := setAt(setAt(setAt(board, mid, null), cur, null), next, ?piece);
            };
            case null return ?"That's not a legal capture sequence.";
          };
          cur := next;
          k += 1;
        };

        let stillCapturing = jumpTargets(board, piece, cur).find<(Nat, Nat)>(
          func((mid, _)) = not captured.contains<Nat>(Nat.equal, mid)
        );
        switch (stillCapturing) {
          case (?_) return ?"You must keep capturing with the same piece.";
          case null {};
        };
        null;
      };
    };
  };

  public func resolve(s : State, seat : TP.Seat, a : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let path = switch (a) {
      case (#move m) [m.from, m.to];
      case (#jump j) j.path;
    };
    let origin = path[0];
    let piece = switch (s.board[origin]) {
      case (?p) p;
      case null Runtime.trap("CheckersRules.resolve: no piece at the origin — validate should have rejected this");
    };

    var board = setAt(s.board, origin, null);
    // Clear the victim of every capturing (two-square) leg.
    var k = 0;
    while (k + 1 < path.size()) {
      let a2 = path[k];
      let b2 = path[k + 1];
      let dr = rowOf(b2).toInt() - rowOf(a2).toInt();
      if (dr == 2 or dr == -2) {
        let dc = colOf(b2).toInt() - colOf(a2).toInt();
        let mr = rowOf(a2).toInt() + dr / 2;
        let mc = colOf(a2).toInt() + dc / 2;
        board := setAt(board, mr.toNat() * SIZE + mc.toNat(), null);
      };
      k += 1;
    };

    let land = path[path.size() - 1];
    let landed = if (rowOf(land) == backRowFor(seat)) promote(piece) else piece;
    board := setAt(board, land, ?landed);

    let verdict : ?TP.Verdict = if (seatHasAnyLegalAction(board, otherSeat(seat))) null else ?(
      switch (seat) {
        case (#p1) #p1Wins;
        case (#p2) #p2Wins;
      }
    );

    { state = { board }; verdict };
  };

  public func spec() : TP.Spec<State, Action> = #alternating {
    init;
    validate;
    resolve;
  };
};
