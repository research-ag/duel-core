/// ═══════════════════════════════════════════════════════════════════════════
/// CheckersRules — standard English draughts, as a pure module.
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = #alternating { init; validate; resolve }
///
/// Seats take turns in order (p1 moves first — see lib.mo's `Table.toMove`
/// doc); there is no "whose turn" flag in `State` because the engine
/// already tracks that. Seat mapping: #p1 = Black, starting on rows 5-7 and
/// moving toward row 0; #p2 = Red, starting on rows 0-2 and moving
/// toward row 7. The board is 8x8, row-major (`index = row*8 + col`),
/// only the dark squares (`(row+col)` odd) ever hold a piece.
///
/// ── Rules ──────────────────────────────────────────────────────────────────
///   MOVE  a man moves one square diagonally FORWARD (toward its own back
///         row) onto an empty square; a king moves one square diagonally
///         in ANY of the four directions.
///   JUMP  a man captures by jumping an adjacent enemy piece — forward
///         only — landing on the empty square immediately beyond; a king
///         captures in any direction. Capturing is MANDATORY: if the
///         seat to move has any legal capture available (with any of
///         their own pieces), only a #jump is legal, never a plain
///         #move. A single #jump submission carries the WHOLE capture
///         chain (every square the piece lands on, start to finish) —
///         the engine resolves one full turn per submission, so a
///         multi-jump combo can't be split across several `submit`
///         calls the way it would be across several physical clicks.
///         The chain must be maximal: it's illegal to stop partway
///         through if the same piece could still capture again from
///         where it landed.
///   KING  a man that reaches the far row (row 0 for Black, row 7 for
///         Red) is promoted once its full move — the whole capture
///         chain, for a multi-jump — resolves and it ends there.
///   WIN   a seat with no legal move at all on their own turn (no pieces
///         left, or every piece blocked) loses.
///
/// ── Deliberate simplifications (see the duel-game-core skill's porting
///    guidance) ──────────────────────────────────────────────────────────
///   - Mandatory capture only requires SOME capture be taken — not the
///     capture sequence with the most pieces taken among several
///     options, a stricter rule some rule sets additionally enforce.
///   - A man's own kind is used for the WHOLE capture chain it's
///     currently making, even if an intermediate landing square is its
///     own back row — i.e. no mid-chain promotion. Promotion is checked
///     only once, against the chain's FINAL landing square.
///   - No draw condition (by repetition, or a move cap with no capture)
///     is implemented — a game only ends by one seat running out of
///     legal moves.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";
import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";

module {

  // ────────────────────────── moves & state ──────────────────────────────

  public type Piece = { #manP1; #manP2; #kingP1; #kingP2 };

  /// 64 cells, row-major (`index = row*8 + col`); only dark squares
  /// (`(row+col)` odd) are ever `?Piece` — every light square stays
  /// `null` for the life of the game.
  public type Board = [?Piece];

  /// A plain move carries just the endpoints; a capture chain carries
  /// every square visited, start to finish (see this module's own doc
  /// header for why the whole chain is one Action).
  public type Action = {
    #move : { from : Nat; to : Nat };
    #jump : { path : [Nat] };
  };

  public type State = { board : Board };

  // ────────────────────────── board geometry ──────────────────────────────

  let SIZE : Nat = 8;
  let SQUARES : Nat = 64;

  // The four diagonal directions, as (row delta, col delta) — shared by
  // both a one-square move and a two-square (times this) capture leg.
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
  // Black (#p1) marches toward row 0; Red (#p2) toward row 7.
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
        // 3 rows of pieces per side; SIZE is fixed at 8, so row 5 (not
        // `SIZE - 3`, which the compiler can't see is underflow-safe) is
        // p1's own back three rows.
        if (r <= 2) ?#manP2 else if (r >= 5) ?#manP1 else null;
      };
    }
  );

  public func init(_variant : Text) : State = { board = startBoard() };

  // ────────────────────────── move generation ─────────────────────────────
  // Both used by `validate` (is THIS specific move/leg legal?) and by the
  // win check (does a seat have ANY legal action at all?) — one source of
  // truth for "what can this piece do," never duplicated.

  /// Legal one-square, non-capturing destinations for `piece` sitting at
  /// `i`, given the CURRENT board.
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

  /// Legal one-leg captures for `piece` sitting at `i`, given the CURRENT
  /// board — each result is `(capturedSquare, landingSquare)`.
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
          case (?_) return null; // landing square must be empty
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

  /// Every MAXIMAL capture chain starting at `origin` (`piece` sitting
  /// there), as full root-to-leaf paths — generalizes `validate`'s own
  /// `#jump` walk (which checks one GIVEN path against the same
  /// `jumpTargets`/maximality rule) into enumerating every branch. A leg
  /// with no further capture available from its landing square (the same
  /// test `validate`'s `stillCapturing` check makes) ends that branch.
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

  /// Every legal `Action` for `seat` on the CURRENT board — the same
  /// legality `validate` enforces (if `seat` has ANY capture available,
  /// only `#jump`s are returned, never a `#move`; each `#jump` already
  /// carries its full, maximal chain), exported so a caller — a bot's own
  /// move selection, most notably (see
  /// `../../../CLAUDE.md`'s "Canister players" note and
  /// `../../../skills/duel-game-core/SKILL.md`'s authoring guide) — has
  /// one source of truth for "what can `seat` do right now" rather than
  /// re-deriving these same capture/mandatory-capture rules itself. An
  /// empty result means `seat` has no legal action at all — the same
  /// condition `resolve`'s own win check tests via
  /// `seatHasAnyLegalAction`.
  public func legalActions(s : State, seat : TP.Seat) : [Action] {
    let out = List.empty<Action>();
    if (seatHasCapture(s.board, seat)) {
      for (i in Nat.range(0, SQUARES)) {
        switch (s.board[i]) {
          // Only a piece that ITSELF has a capture available contributes
          // chains — `seatHasCapture` only guarantees SOME piece does,
          // not this one; skipping this check would let a capture-less
          // piece's own empty leg set look like a (bogus, one-square,
          // non-capturing) "maximal chain" via `captureChainsFrom`'s base
          // case.
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

  // ────────────────────────── Spec: validate ───────────────────────────────

  /// null = legal. Called only for the seat currently on turn — the
  /// engine itself rejects an off-turn submission before this ever runs.
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

        // Walk the chain leg by leg against a board updated after EACH
        // leg (captured piece removed, prior square cleared, piece
        // placed at the new landing square) — otherwise a later leg
        // would be checked against the ORIGINAL board, which still
        // shows the piece's own vacated squares as occupied and could
        // wrongly reject a legal landing there. `captured` separately
        // tracks victims so the same one can't be jumped twice.
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

        // The chain must be maximal: this SAME piece (by kind — see this
        // module's own doc header on mid-chain promotion) may not still
        // have a capture available from where it ended up.
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

  // ────────────────────────── Spec: resolve ────────────────────────────────

  /// The on-turn seat's move is already validated. Pure: State in, new
  /// State + optional verdict out.
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
    // Clear the captured victim of every CAPTURING leg (two squares
    // apart) — a plain #move's single leg is one square apart, so this
    // loop is a no-op for it.
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

  // ────────────────────────── the plug ─────────────────────────────────────

  /// Hand this to every duel-game-core engine call. Built fresh per call —
  /// function values are never stored, so upgrades stay trivial.
  /// `#alternating`: Black and Red take turns, one move per submission.
  public func spec() : TP.Spec<State, Action> = #alternating {
    init;
    validate;
    resolve;
  };
};
