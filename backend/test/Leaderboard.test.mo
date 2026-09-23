// Unit checks for `leaderboard.mo`'s generic top-N `Board`. No engine
// dependency — a `Board` is a plain mutable record, exercised directly,
// same "plain interpreter script" style as every other suite here.
// Run: moc -r --package core <core/src> test/Leaderboard.test.mo
import Leaderboard "../src/leaderboard";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

func expectTop(b : Leaderboard.Board, want : [(Text, Int)], msg : Text) {
  let got = Leaderboard.top(b, want.size());
  if (got.size() != want.size()) {
    Runtime.trap(msg # ": expected " # debug_show (want.size()) # " entries, got " # debug_show (got.size()));
  };
  for (i in got.keys()) {
    let (wantPlayer, wantScore) = want[i];
    if (got[i].player != wantPlayer or got[i].score != wantScore) {
      Runtime.trap(msg # ": entry " # debug_show (i) # " was " # debug_show (got[i].player, got[i].score) # ", wanted " # debug_show (want[i]));
    };
  };
};

// ── 1. setScore(): a fresh board with a couple of players sorts
//      highest-score-first. ────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  Leaderboard.setScore(b, "alice", 1200, 0);
  Leaderboard.setScore(b, "bob", 1400, 0);
  Leaderboard.setScore(b, "carl", 1000, 0);
  expectTop(b, [("bob", 1400), ("alice", 1200), ("carl", 1000)], "1");
  Debug.print("1. setScore() keeps the board sorted highest-first OK");
};

// ── 2. setScore(): re-scoring an existing player REPLACES their entry
//      (never adds a second row) and can move them either direction —
//      the ELO semantics (ratings move up AND down).
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  Leaderboard.setScore(b, "alice", 1200, 0);
  Leaderboard.setScore(b, "bob", 1400, 0);
  Leaderboard.setScore(b, "alice", 1600, 1); // alice overtakes bob
  expectTop(b, [("alice", 1600), ("bob", 1400)], "2a: alice moved up, no duplicate row");
  Leaderboard.setScore(b, "alice", 100, 2); // and can drop just as freely
  expectTop(b, [("bob", 1400), ("alice", 100)], "2b: alice can also drop below someone she'd passed");
  Debug.print("2. setScore() replaces (never duplicates) and moves either direction OK");
};

// ── 3. recordIfBetter(): only overwrites on a strict improvement — a
//      personal-best metric (e.g. racing's converted lap time) must
//      never regress.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  ignore Leaderboard.recordIfBetter(b, "alice", 100, 0);
  let improved = Leaderboard.recordIfBetter(b, "alice", 150, 1); // better
  if (not improved) Runtime.trap("3a: a strictly higher score must count as an improvement");
  expectTop(b, [("alice", 150)], "3b: the improved score is on record");
  let worse = Leaderboard.recordIfBetter(b, "alice", 120, 2); // worse than 150
  if (worse) Runtime.trap("3c: a worse score must not report a change");
  expectTop(b, [("alice", 150)], "3d: the earlier, better score must survive untouched");
  let tie = Leaderboard.recordIfBetter(b, "alice", 150, 3); // exactly equal
  if (tie) Runtime.trap("3e: an exact tie is not an improvement");
  Debug.print("3. recordIfBetter() only ever moves a player's score up OK");
};

// ── 4. Trimming: a board kept at N never grows past N, and the LOWEST
//      score is what gets dropped as better ones arrive.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(3, 0);
  Leaderboard.setScore(b, "a", 10, 0);
  Leaderboard.setScore(b, "b", 20, 0);
  Leaderboard.setScore(b, "c", 30, 0);
  expectTop(b, [("c", 30), ("b", 20), ("a", 10)], "4a: exactly at capacity");
  Leaderboard.setScore(b, "d", 25, 0); // bumps "a" (the worst) off entirely
  expectTop(b, [("c", 30), ("d", 25), ("b", 20)], "4b: the worst entry was dropped to stay at keep=3");
  Debug.print("4. a board never grows past its own `keep` OK");
};

// ── 5. recordIfBetter() at capacity: a new player's score that doesn't
//      beat the current worst kept entry is correctly rejected (never
//      even added, unlike setScore's unconditional overwrite) — this is
//      exactly the "buffer of 2x the shown top-N" scenario: a table kept
//      at 50 rejects a 51st-best newcomer outright.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(2, 0);
  ignore Leaderboard.recordIfBetter(b, "a", 100, 0);
  ignore Leaderboard.recordIfBetter(b, "b", 90, 0);
  let tooLow = Leaderboard.recordIfBetter(b, "c", 50, 0); // worse than both
  if (tooLow) Runtime.trap("5a: a newcomer below the worst kept entry must be rejected");
  expectTop(b, [("a", 100), ("b", 90)], "5b: the board must be unchanged");
  let goodEnough = Leaderboard.recordIfBetter(b, "c", 95, 0); // beats "b"
  if (not goodEnough) Runtime.trap("5c: a newcomer beating the worst kept entry must be accepted");
  expectTop(b, [("a", 100), ("c", 95)], "5d: \"b\" (the old worst) is bumped out entirely");
  Debug.print("5. recordIfBetter() at capacity only admits a newcomer who beats the worst kept entry OK");
};

// ── 6. top(n): asking for more than exist returns everything there is,
//      no error, no padding.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  Leaderboard.setScore(b, "alice", 1200, 0);
  let got = Leaderboard.top(b, 25);
  if (got.size() != 1) Runtime.trap("6: top(n) beyond the board's size must just return what exists, got " # debug_show (got.size()));
  Debug.print("6. top(n) beyond the board's own size returns everything there is OK");
};

// ── 7. Ties: equal scores don't crash or drop an entry — both survive
//      (in whatever stable relative order `Array.sort` gives them),
//      still capped at `keep`.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  Leaderboard.setScore(b, "alice", 1000, 0);
  Leaderboard.setScore(b, "bob", 1000, 0);
  let got = Leaderboard.top(b, 10);
  if (got.size() != 2) Runtime.trap("7: a tie must not drop either entry, got " # debug_show (got.size()));
  Debug.print("7. a tie between two scores keeps both entries OK");
};

// ── 8. get(): a single player's current entry, or null for someone
//      never recorded (or bumped off the buffer since).
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 0);
  Leaderboard.setScore(b, "alice", 1234, 7);
  switch (Leaderboard.get(b, "alice")) {
    case (?e) {
      if (e.score != 1234 or e.updatedAt != 7) Runtime.trap("8a: get() returned the wrong entry for alice");
    };
    case null Runtime.trap("8b: get() must find an existing player");
  };
  switch (Leaderboard.get(b, "nobody")) {
    case (?_) Runtime.trap("8c: get() must return null for a player never recorded");
    case null {};
  };
  Debug.print("8. get() finds an existing player's entry and null otherwise OK");
};

// ── 9. scoreOf(): an existing player's own score, or the board's own
//      `defaultScore` for someone never recorded — the host's own
//      starting-rating choice, made once at `new`, not hardcoded here.
// ────────────────────────────────────────────────────────────────────
do {
  let b = Leaderboard.new(50, 1200); // e.g. a chess-ELO "unrated" default
  if (Leaderboard.scoreOf(b, "nobody") != 1200) {
    Runtime.trap("9a: scoreOf() must fall back to the board's own defaultScore");
  };
  Leaderboard.setScore(b, "alice", 1350, 0);
  if (Leaderboard.scoreOf(b, "alice") != 1350) {
    Runtime.trap("9b: scoreOf() must return an existing player's real score, not the default");
  };
  Debug.print("9. scoreOf() falls back to defaultScore, or returns the real score if one exists OK");
};

Debug.print("ALL LEADERBOARD CHECKS PASSED");
