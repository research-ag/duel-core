// Unit checks for RockPaperScissorsRules' pure functions: init/validate/
// resolve exercised directly, no engine, no actor.
// Run: moc -r --package core <core/src> --package duel-game-core
//      <duel-game-core-backend/src> test/RulesUnit.test.mo
import R "../src/RockPaperScissorsRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

func round(s : R.State, a1 : R.Action, a2 : R.Action) : R.State {
  let r = R.resolve(s, a1, a2);
  switch (r.verdict) { case null {}; case (?_) Runtime.trap("unexpected end") };
  r.state;
};

// ── 1. init() is a clean slate, and spec() hands out the same rules ────────
let s0 = R.init();
assert s0.p1Score == 0;
assert s0.p2Score == 0;
assert s0.lastRound == null;
let sp = switch (R.spec()) {
  case (#simultaneous s) s;
  case (#alternating _) Runtime.trap("rock-paper-scissors is a #simultaneous game");
};
assert sp.init() == s0;
Debug.print("1. init + spec wiring OK");

// ── 2. validate: every pick is always legal ─────────────────────────────────
switch (R.validate(s0, #p1, #rock)) {
  case null {};
  case (?_) Runtime.trap("rock must always be legal");
};
switch (R.validate(s0, #p2, #scissors)) {
  case null {};
  case (?_) Runtime.trap("scissors must always be legal");
};
Debug.print("2. validate OK");

// ── 3. resolve: the three beats-relationships, and a tie scores nobody ─────
do {
  let r = R.resolve(s0, #rock, #scissors);
  assert r.state.p1Score == 1 and r.state.p2Score == 0;
  assert r.verdict == null; // 1 win isn't a match yet
};
do {
  let r = R.resolve(s0, #scissors, #paper);
  assert r.state.p1Score == 1 and r.state.p2Score == 0;
};
do {
  let r = R.resolve(s0, #paper, #rock);
  assert r.state.p1Score == 1 and r.state.p2Score == 0;
};
do {
  let r = R.resolve(s0, #rock, #paper);
  assert r.state.p1Score == 0 and r.state.p2Score == 1;
};
do {
  let r = R.resolve(s0, #rock, #rock);
  assert r.state.p1Score == 0 and r.state.p2Score == 0; // a tied round scores nobody
  assert r.state.lastRound == ?{ p1Action = #rock; p2Action = #rock };
};
Debug.print("3. resolve: beats-relationships + tie OK");

// ── 4. resolve: first to 3 round wins takes the match ───────────────────────
do {
  var s = s0;
  s := round(s, #rock, #scissors); // p1: 1
  s := round(s, #rock, #scissors); // p1: 2
  let r = R.resolve(s, #rock, #scissors); // p1: 3 — match point
  switch (r.verdict) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("p1 should win the match at 3 round wins");
  };
};
do {
  var s = s0;
  s := round(s, #scissors, #rock); // p2: 1
  s := round(s, #scissors, #rock); // p2: 2
  let r = R.resolve(s, #scissors, #rock); // p2: 3 — match point
  switch (r.verdict) {
    case (?#p2Wins) {};
    case (_) Runtime.trap("p2 should win the match at 3 round wins");
  };
};
Debug.print("4. first-to-3 match win OK");

Debug.print("ALL ROCKPAPERSCISSORSRULES RULESUNIT CHECKS PASSED");
