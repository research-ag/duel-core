// Unit checks for `elo.mo`'s pure rating formula.
import Elo "../src/elo";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

func expectEq(got : Int, want : Int, msg : Text) {
  if (got != want) {
    Runtime.trap(msg # ": got " # debug_show (got) # ", want " # debug_show (want));
  };
};

// ── 1. Equal ratings, A wins: expected score is 0.5 each, so A gains exactly
//      k/2 and B loses exactly k/2 ──────────────────────────────────────────
do {
  let (newA, newB) = Elo.update(1200, 1200, #aWins, 32);
  expectEq(newA, 1216, "1a: winner from an even match gains k/2");
  expectEq(newB, 1184, "1b: loser from an even match loses k/2");
  Debug.print("1. equal ratings, A wins: +16/-16 (k=32) OK");
};

// ── 2. Equal ratings, draw: both already at their expected outcome (0.5) ───
do {
  let (newA, newB) = Elo.update(1500, 1500, #draw, 32);
  expectEq(newA, 1500, "2a: a draw between equals changes nothing for A");
  expectEq(newB, 1500, "2b: ...or for B");
  Debug.print("2. equal ratings, draw: no change OK");
};

// ── 3. A big favorite (400 points up) winning gains very little ────────────
do {
  let (newA, newB) = Elo.update(1800, 1400, #aWins, 32);
  let gain = newA - 1800;
  if (gain < 0 or gain > 4) {
    Runtime.trap("3a: a heavy favorite's win should gain only a couple of points, got " # debug_show (gain));
  };
  expectEq(1800 - newA, newB - 1400, "3b: zero-sum — A's move is the exact negative of B's");
  Debug.print("3. a 400-point favorite winning gains only a few points OK");
};

// ── 4. The mirror of #3: a huge underdog (400 points down) who wins gains
//      nearly the full k-factor ─────────────────────────────────────────────
do {
  let (newA, newB) = Elo.update(1400, 1800, #aWins, 32);
  let gain = newA - 1400;
  if (gain < 28 or gain > 32) {
    Runtime.trap("4a: a 400-point underdog's win should gain nearly the full k, got " # debug_show (gain));
  };
  expectEq(1400 - newA, newB - 1800, "4b: zero-sum holds here too");
  Debug.print("4. a 400-point underdog winning gains nearly the full k-factor OK");
};

// ── 5. Zero-sum holds across an arbitrary spread of ratings, outcomes, and
//      k-factors ────────────────────────────────────────────────────────────
do {
  let cases : [(Int, Int, Elo.Outcome, Nat)] = [
    (1200, 1200, #bWins, 16),
    (900, 2100, #bWins, 24),
    (2100, 900, #draw, 40),
    (1000, 1000, #aWins, 10),
  ];
  for ((ra, rb, outcome, k) in cases.values()) {
    let (newA, newB) = Elo.update(ra, rb, outcome, k);
    expectEq(newA - ra, -(newB - rb), "5: zero-sum for " # debug_show (ra, rb, k));
  };
  Debug.print("5. zero-sum holds across a spread of ratings/outcomes/k-factors OK");
};

// ── 6. k = 0 never moves a rating, whatever the outcome ────────────────────
do {
  let (newA, newB) = Elo.update(1500, 1100, #aWins, 0);
  expectEq(newA, 1500, "6a: k=0 must never move the winner");
  expectEq(newB, 1100, "6b: ...or the loser");
  Debug.print("6. k=0 never moves a rating OK");
};

// ── 7. #bWins is the mirror of #aWins ──────────────────────────────────────
do {
  let (winA, loseB) = Elo.update(1300, 1300, #aWins, 32);
  let (loseA, winB) = Elo.update(1300, 1300, #bWins, 32);
  expectEq(winA, winB, "7a: the winning side's new rating is the same regardless of label");
  expectEq(loseA, loseB, "7b: ...and so is the losing side's");
  Debug.print("7. #aWins and #bWins are mirror images of each other OK");
};

Debug.print("ALL ELO CHECKS PASSED");
