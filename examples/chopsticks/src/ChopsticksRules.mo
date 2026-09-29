/// ═══════════════════════════════════════════════════════════════════════════
/// ChopsticksRules — the hand game chopsticks, as a pure module, with two
/// table-time variants (Classic and Instructables) picked once by the
/// table's creator at `createTable` time — see `../CLAUDE.md`'s
/// "Game-rule notes" for the full rules text of both.
///
/// No actor, no shared functions, no storage, no Time — just the rules.
/// Plugs into the generic `duel-game-core` engine via `spec()`:
///
///   TP.Spec<State, Action> = #alternating { init; validate; resolve }
///
/// Seats take turns (p1 moves first); the engine tracks whose turn it
/// is, so `State` carries no turn flag. Each player has two hands, left
/// and right, each holding 0 (out) to 4 fingers; both start at 1.
///
/// ── Rules ──────────────────────────────────────────────────────────────────
///   ATTACK  tap one of your own live hands onto one of the opponent's
///           live hands: the target gains the attacker's count, the
///           attacker is unchanged. Classic: a hand reaching 5 or more is
///           out. Instructables: exactly 5 is out; more wraps (`mod 5`).
///   SPLIT   redistribute your own total across your two hands. Classic:
///           any redistribution with neither hand at 5+, except staying
///           put or a pure swap. Instructables: only when one hand is
///           out and the other is even, and always exactly half to each.
///   WIN     the first seat to put BOTH of the opponent's hands out. No
///           draw condition.
/// ═══════════════════════════════════════════════════════════════════════════

import TP "mo:duel-game-core";
import List "mo:core/List";
import Nat "mo:core/Nat";

module {

  // ────────────────────────── variants ─────────────────────────────────────

  public type Variant = { #classic; #instructables };

  /// Unrecognized text (including `""`) falls back to `#classic`.
  public func parseVariant(raw : Text) : Variant = switch (raw) {
    case ("instructables") #instructables;
    case (_) #classic;
  };

  // ────────────────────────── moves & state ──────────────────────────────

  public type HandId = { #l; #r };

  /// 0 = out; otherwise 1..4.
  public type Hands = { l : Nat; r : Nat };

  public type Action = {
    #attack : { from : HandId; to : HandId };
    #split : { l : Nat; r : Nat };
  };

  public type State = {
    variant : Variant;
    p1 : Hands;
    p2 : Hands;
  };

  let MAX_HAND : Nat = 4;
  let OUT_AT : Nat = 5;

  // ────────────────────────── helpers ──────────────────────────────────────

  public func other(seat : TP.Seat) : TP.Seat = switch (seat) {
    case (#p1) #p2;
    case (#p2) #p1;
  };

  public func handsOf(s : State, seat : TP.Seat) : Hands = switch (seat) {
    case (#p1) s.p1;
    case (#p2) s.p2;
  };

  func withHands(s : State, seat : TP.Seat, h : Hands) : State = switch (seat) {
    case (#p1) ({ s with p1 = h });
    case (#p2) ({ s with p2 = h });
  };

  public func get(h : Hands, id : HandId) : Nat = switch (id) {
    case (#l) h.l;
    case (#r) h.r;
  };

  func set(h : Hands, id : HandId, v : Nat) : Hands = switch (id) {
    case (#l) ({ h with l = v });
    case (#r) ({ h with r = v });
  };

  public func liveHands(h : Hands) : Nat = (if (h.l > 0) 1 else 0) + (if (h.r > 0) 1 else 0);

  public func isOut(h : Hands) : Bool = liveHands(h) == 0;

  // ────────────────────────── Spec: init ───────────────────────────────────

  public func init(raw : Text) : State = {
    variant = parseVariant(raw);
    p1 = { l = 1; r = 1 };
    p2 = { l = 1; r = 1 };
  };

  // ────────────────────────── Spec: validate ───────────────────────────────

  func validateSplit(variant : Variant, cur : Hands, l : Nat, r : Nat) : ?Text {
    let total = cur.l + cur.r;
    if (total == 0) return ?"No fingers left to split.";
    if (l + r != total) return ?"A split must keep the same total.";
    switch (variant) {
      case (#classic) {
        if (l > MAX_HAND or r > MAX_HAND) return ?"A hand can't hold five or more fingers.";
        if ((l == cur.l and r == cur.r) or (l == cur.r and r == cur.l)) {
          return ?"Must differ from current and not be a pure swap.";
        };
        null;
      };
      case (#instructables) {
        if (cur.l > 0 and cur.r > 0) return ?"Split only when one hand is out.";
        if (total % 2 != 0) return ?"Split only when the live hand is even.";
        if (l != r) return ?"Splits are always even.";
        null;
      };
    };
  };

  /// null = legal. Called only for the seat currently on turn.
  public func validate(s : State, seat : TP.Seat, a : Action) : ?Text {
    let mine = handsOf(s, seat);
    switch (a) {
      case (#attack { from; to }) {
        if (get(mine, from) == 0) return ?"That hand is out.";
        if (get(handsOf(s, other(seat)), to) == 0) return ?"That hand is already out.";
        null;
      };
      case (#split { l; r }) validateSplit(s.variant, mine, l, r);
    };
  };

  /// Every legal `Action` for `seat` — exactly what `validate` accepts,
  /// attacks first (from l/r × to l/r), then splits by ascending left hand.
  public func legalActions(s : State, seat : TP.Seat) : [Action] {
    let out = List.empty<Action>();
    let mine = handsOf(s, seat);
    for (from in [#l, #r].values()) {
      for (to in [#l, #r].values()) {
        let a : Action = #attack { from; to };
        if (validate(s, seat, a) == null) out.add(a);
      };
    };
    let total = mine.l + mine.r;
    for (l in Nat.rangeInclusive(0, total)) {
      let a : Action = #split { l; r = total - l };
      if (validate(s, seat, a) == null) out.add(a);
    };
    out.toArray();
  };

  // ────────────────────────── Spec: resolve ────────────────────────────────

  func hit(variant : Variant, target : Nat, attacker : Nat) : Nat {
    let sum = target + attacker;
    switch (variant) {
      case (#classic) if (sum >= OUT_AT) 0 else sum;
      case (#instructables) sum % OUT_AT;
    };
  };

  /// The on-turn seat's move is already validated. Pure: State in, new
  /// State + optional verdict out.
  public func resolve(s : State, seat : TP.Seat, a : Action) : {
    state : State;
    verdict : ?TP.Verdict;
  } {
    let opp = other(seat);
    let state = switch (a) {
      case (#attack { from; to }) {
        let theirs = handsOf(s, opp);
        withHands(s, opp, set(theirs, to, hit(s.variant, get(theirs, to), get(handsOf(s, seat), from))));
      };
      case (#split { l; r }) withHands(s, seat, { l; r });
    };
    let verdict : ?TP.Verdict = if (isOut(handsOf(state, opp))) {
      ?(switch (seat) { case (#p1) #p1Wins; case (#p2) #p2Wins });
    } else null;
    { state; verdict };
  };

  // ────────────────────────── the plug ─────────────────────────────────────

  /// Built fresh per call — function values are never stored.
  public func spec() : TP.Spec<State, Action> = #alternating {
    init;
    validate;
    resolve;
  };
};
