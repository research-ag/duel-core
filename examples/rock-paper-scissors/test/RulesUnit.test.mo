// Unit checks for RockPaperScissorsRules' pure functions: init/validate/
// resolve exercised directly, no engine, no actor.
import Rng "mo:duel-game-core/rng";
import R "../src/RockPaperScissorsRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

func round(s : R.State, a1 : R.Action, a2 : R.Action) : R.State {
  let r = R.resolve(s, a1, a2);
  switch (r.verdict) { case null {}; case (?_) Runtime.trap("unexpected end") };
  r.state;
};

// ── 1. init(variant) picks the right rules, unrecognized text falls back to
//      classic, and spec() hands out the same rules ─────────────────────────
let s0 = R.init({ variant = #classic; winsNeeded = 3 }, rng);
assert s0.p1Score == 0;
assert s0.p2Score == 0;
assert s0.lastRound == null;
assert s0.variant == #classic; // "" (every other example's own call shape) defaults to classic
let s0Well = R.init({ variant = #well; winsNeeded = 3 }, rng);
assert s0Well.variant == #well;
assert R.init({ variant = #classic; winsNeeded = 3 }, rng).variant == #classic; // unrecognized text is a safe default, not a trap
let sp = switch (R.spec) {
  case (#simultaneous s) s;
  case (#turnBased _) Runtime.trap("rock-paper-scissors is a #simultaneous game");
};
assert sp.init({ variant = #classic; winsNeeded = 3 }, rng) == s0;
Debug.print("1. init(variant) + spec wiring OK");

// ── 2. validate: well is illegal in classic, legal in well ─────────────────
switch (R.validate(s0, #p1, #well)) {
  case (?_) {};
  case null Runtime.trap("well must be illegal in classic mode");
};
switch (R.validate(s0Well, #p1, #well)) {
  case null {};
  case (?_) Runtime.trap("well must be legal in well mode");
};
switch (R.validate(s0, #p1, #rock)) {
  case null {};
  case (?_) Runtime.trap("rock must always be legal");
};
switch (R.validate(s0Well, #p2, #scissors)) {
  case null {};
  case (?_) Runtime.trap("scissors must always be legal");
};
Debug.print("2. validate: well gated to well mode, everything else always legal OK");

// ── 3. resolve: every one of the six distinct pairs has exactly one winner,
//      and a tie scores nobody ──────────────────────────────────────────────
do {
  let r = R.resolve(s0, #rock, #scissors);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // rock beats scissors
};
do {
  let r = R.resolve(s0, #paper, #rock);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // paper beats rock
};
do {
  let r = R.resolve(s0Well, #paper, #well);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // paper beats well
};
do {
  let r = R.resolve(s0, #scissors, #paper);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // scissors beats paper
};
do {
  let r = R.resolve(s0Well, #well, #rock);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // well beats rock
};
do {
  let r = R.resolve(s0Well, #well, #scissors);
  assert r.state.p1Score == 1 and r.state.p2Score == 0; // well beats scissors
};
// The mirror image of each pair above must score the OTHER seat instead.
do {
  let r = R.resolve(s0, #scissors, #rock);
  assert r.state.p1Score == 0 and r.state.p2Score == 1;
};
do {
  let r = R.resolve(s0Well, #rock, #well);
  assert r.state.p1Score == 0 and r.state.p2Score == 1;
};
do {
  let r = R.resolve(s0Well, #well, #well);
  assert r.state.p1Score == 0 and r.state.p2Score == 0; // same pick both sides — a tie
  assert r.state.lastRound == ?{ p1Action = #well; p2Action = #well };
  assert r.state.variant == #well; // resolve carries the match's own variant forward unchanged
};
do {
  let r = R.resolve(s0, #rock, #rock);
  assert r.state.p1Score == 0 and r.state.p2Score == 0;
  assert r.state.lastRound == ?{ p1Action = #rock; p2Action = #rock };
};
Debug.print("3. resolve: all six beats-relationships + tie OK");

// ── 4. resolve: first to 3 round wins takes the match, in either mode ──────
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
  var s = s0Well;
  s := round(s, #well, #rock); // p1: 1
  s := round(s, #well, #scissors); // p1: 2
  let r = R.resolve(s, #paper, #rock); // p1: 3 — match point
  switch (r.verdict) {
    case (?#p1Wins) {};
    case (_) Runtime.trap("p1 should win the match at 3 round wins");
  };
};
do {
  var s = s0Well;
  s := round(s, #rock, #well); // p2: 1
  s := round(s, #scissors, #well); // p2: 2
  let r = R.resolve(s, #rock, #paper); // p2: 3 — match point
  switch (r.verdict) {
    case (?#p2Wins) {};
    case (_) Runtime.trap("p2 should win the match at 3 round wins");
  };
};
Debug.print("4. first-to-3 match win OK");

Debug.print("ALL ROCKPAPERSCISSORSRULES RULESUNIT CHECKS PASSED");
