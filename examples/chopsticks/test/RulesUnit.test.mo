// Unit checks for ChopsticksRules' pure functions: init/validate/resolve
// exercised directly against synthetic positions, no engine, no actor.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/RulesUnit.test.mo
import R "../src/ChopsticksRules";
import TP "mo:duel-game-core";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

func pos(variant : R.Variant, p1 : (Nat, Nat), p2 : (Nat, Nat)) : R.State = {
  variant;
  p1 = { l = p1.0; r = p1.1 };
  p2 = { l = p2.0; r = p2.1 };
};

func legal(s : R.State, seat : TP.Seat, a : R.Action, msg : Text) = switch (R.validate(s, seat, a)) {
  case null {};
  case (?why) Runtime.trap(msg # " should be legal, got: " # why);
};
func illegal(s : R.State, seat : TP.Seat, a : R.Action, msg : Text) = switch (R.validate(s, seat, a)) {
  case (?_) {};
  case null Runtime.trap(msg # " should be illegal");
};

// ── 1. init: both hands at 1 on both sides; the variant text is parsed ─────
do {
  let s0 = R.init("");
  assert s0.p1 == { l = 1; r = 1 };
  assert s0.p2 == { l = 1; r = 1 };
  assert s0.variant == #classic;
  assert R.init("instructables").variant == #instructables;
  assert R.init("classic").variant == #classic;
  assert R.init("garbage").variant == #classic;
};
Debug.print("1. init() OK");

// ── 2. spec() hands out the same rules, in #alternating mode ───────────────
do {
  let sp = switch (R.spec()) {
    case (#alternating s) s;
    case (#simultaneous _) Runtime.trap("chopsticks is a #alternating game");
  };
  assert sp.init("instructables") == R.init("instructables");
};
Debug.print("2. spec wiring OK");

// ── 3. validate attack: live hands only, on both ends ──────────────────────
do {
  let s = pos(#classic, (0, 2), (3, 0));
  legal(s, #p1, #attack { from = #r; to = #l }, "live r onto live l");
  illegal(s, #p1, #attack { from = #l; to = #l }, "attacking with an out hand");
  illegal(s, #p1, #attack { from = #r; to = #r }, "attacking an out hand");
  legal(s, #p2, #attack { from = #l; to = #r }, "p2's live l onto p1's live r");
  illegal(s, #p2, #attack { from = #r; to = #r }, "p2 attacking with an out hand");
};
Debug.print("3. validate attack OK");

// ── 4. validate split, classic: free, minus staying put / a pure swap / a
//        hand of five or more; splitting down to 0 is allowed ───────────────
do {
  let s = pos(#classic, (3, 1), (1, 1));
  legal(s, #p1, #split { l = 2; r = 2 }, "3+1 -> 2+2");
  legal(s, #p1, #split { l = 0; r = 4 }, "3+1 -> 0+4");
  legal(s, #p1, #split { l = 4; r = 0 }, "3+1 -> 4+0");
  illegal(s, #p1, #split { l = 3; r = 1 }, "staying put");
  illegal(s, #p1, #split { l = 1; r = 3 }, "a pure swap");
  illegal(s, #p1, #split { l = 2; r = 1 }, "changing the total");
  let big = pos(#classic, (4, 2), (1, 1));
  illegal(big, #p1, #split { l = 5; r = 1 }, "a hand of five");
  legal(big, #p1, #split { l = 3; r = 3 }, "4+2 -> 3+3");
  let oneOut = pos(#classic, (0, 4), (1, 1));
  legal(oneOut, #p1, #split { l = 1; r = 3 }, "reviving from 0+4");
  illegal(oneOut, #p1, #split { l = 4; r = 0 }, "0+4 -> 4+0 is a pure swap");
  illegal(pos(#classic, (0, 0), (1, 1)), #p1, #split { l = 0; r = 0 }, "nothing to split");
};
Debug.print("4. validate split, classic OK");

// ── 5. validate split, instructables: only one hand out AND the other
//        even, and always exactly half to each ─────────────────────────────
do {
  illegal(pos(#instructables, (3, 1), (1, 1)), #p1, #split { l = 2; r = 2 }, "both hands live");
  illegal(pos(#instructables, (0, 3), (1, 1)), #p1, #split { l = 1; r = 2 }, "odd live hand");
  let ok4 = pos(#instructables, (0, 4), (1, 1));
  legal(ok4, #p1, #split { l = 2; r = 2 }, "0+4 -> 2+2");
  illegal(ok4, #p1, #split { l = 1; r = 3 }, "uneven split");
  illegal(ok4, #p1, #split { l = 4; r = 0 }, "a swap is not an even split");
  legal(pos(#instructables, (2, 0), (1, 1)), #p1, #split { l = 1; r = 1 }, "2+0 -> 1+1");
};
Debug.print("5. validate split, instructables OK");

// ── 6. resolve attack, classic: 5 or more is out, no wraparound ────────────
do {
  let r1 = R.resolve(pos(#classic, (4, 1), (1, 3)), #p1, #attack { from = #l; to = #l });
  assert r1.state.p2 == { l = 0; r = 3 }; // 1 + 4 = 5 -> out
  assert r1.state.p1 == { l = 4; r = 1 }; // attacker unchanged
  assert r1.verdict == null;
  let r2 = R.resolve(pos(#classic, (4, 1), (1, 3)), #p1, #attack { from = #l; to = #r });
  assert r2.state.p2 == { l = 1; r = 0 }; // 3 + 4 = 7 -> out, not 2
  let r3 = R.resolve(pos(#classic, (2, 1), (2, 3)), #p1, #attack { from = #l; to = #l });
  assert r3.state.p2 == { l = 4; r = 3 };
};
Debug.print("6. resolve attack, classic OK");

// ── 7. resolve attack, instructables: exactly 5 is out, above wraps mod 5 ──
do {
  let r1 = R.resolve(pos(#instructables, (2, 1), (4, 3)), #p1, #attack { from = #l; to = #l });
  assert r1.state.p2 == { l = 1; r = 3 }; // 4 + 2 = 6 -> 1
  let r2 = R.resolve(pos(#instructables, (2, 1), (4, 3)), #p1, #attack { from = #r; to = #l });
  assert r2.state.p2 == { l = 0; r = 3 }; // 4 + 1 = 5 -> out
  let r3 = R.resolve(pos(#instructables, (4, 1), (4, 3)), #p1, #attack { from = #l; to = #l });
  assert r3.state.p2 == { l = 3; r = 3 }; // 4 + 4 = 8 -> 3
};
Debug.print("7. resolve attack, instructables OK");

// ── 8. resolve: putting the opponent's last hand out wins, for either seat ─
do {
  let r1 = R.resolve(pos(#classic, (2, 0), (3, 0)), #p1, #attack { from = #l; to = #l });
  assert r1.state.p2 == { l = 0; r = 0 };
  assert r1.verdict == ?#p1Wins;
  let r2 = R.resolve(pos(#instructables, (0, 1), (1, 4)), #p2, #attack { from = #r; to = #r });
  assert r2.verdict == ?#p2Wins;
  // Wrapping past 5 never puts a hand out.
  let r3 = R.resolve(pos(#instructables, (0, 3), (1, 4)), #p2, #attack { from = #r; to = #r });
  assert r3.state.p1 == { l = 0; r = 2 };
  assert r3.verdict == null;
};
Debug.print("8. resolve win OK");

// ── 9. resolve split: applies to the mover's own hands, never ends the game ─
do {
  let r = R.resolve(pos(#classic, (0, 4), (1, 1)), #p1, #split { l = 2; r = 2 });
  assert r.state.p1 == { l = 2; r = 2 };
  assert r.state.p2 == { l = 1; r = 1 };
  assert r.state.variant == #classic;
  assert r.verdict == null;
};
Debug.print("9. resolve split OK");

// ── 10. legalActions: exactly what validate accepts ────────────────────────
do {
  func check(s : R.State, seat : TP.Seat, expected : Nat) {
    let moves = R.legalActions(s, seat);
    assert moves.size() == expected;
    for (a in moves.values()) legal(s, seat, a, "legalActions entry " # debug_show (a));
  };
  // Opening, classic: 4 attacks + 1+1 -> 0+2 / 2+0 (1+1 itself is both
  // staying put and its own swap).
  check(R.init(""), #p1, 6);
  // Opening, instructables: 4 attacks, no split with both hands live.
  check(R.init("instructables"), #p1, 4);
  // One hand out on each side, classic: 1 attack + 3 splits of 4
  // (1+3, 2+2, 3+1 — 0+4 stays put, 4+0 is a swap).
  check(pos(#classic, (0, 4), (0, 2)), #p1, 4);
  // Same position, instructables: 1 attack + the one even split.
  check(pos(#instructables, (0, 4), (0, 2)), #p1, 2);
  // Odd live hand, instructables: attacks only.
  check(pos(#instructables, (0, 3), (2, 2)), #p1, 2);
  // Full total of 8 has no classic split at all (4+4 is the only shape).
  check(pos(#classic, (4, 4), (1, 1)), #p1, 4);
};
Debug.print("10. legalActions mirrors validate's own legality OK");

Debug.print("ALL CHOPSTICKS RULESUNIT CHECKS PASSED");
