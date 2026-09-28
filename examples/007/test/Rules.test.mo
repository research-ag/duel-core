// Unit checks for the pure 007 rules.
// Run: moc -r --package core <core/src> --package duel-game-core <backend/src> test/Rules.test.mo
import R "../src/Duel007Rules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

// Shorthand: run one round, trap if verdict shape unexpected.
func round(s : R.State, a1 : R.Action, a2 : R.Action) : R.State {
  let r = R.resolve(s, a1, a2);
  switch (r.verdict) { case null {}; case (?_) Runtime.trap("unexpected end") };
  r.state;
};

// 1. Both shoot → draw.
var s = R.init("");
s := round(s, #load, #load);
let bothShoot = R.resolve(s, #shoot, #shoot);
switch (bothShoot.verdict) {
  case (?#draw) {};
  case (_) Runtime.trap("both-shoot must draw");
};
Debug.print("1. both-shoot draw OK");

// 2. Mirror reflects a normal shot back.
s := R.init("");
s := round(s, #load, #load);
let mirrored = R.resolve(s, #shoot, #mirror);
switch (mirrored.verdict) {
  case (?#p2Wins) {};
  case (_) Runtime.trap("mirror must kill shooter");
};
Debug.print("2. mirror reflect OK");

// 3. Shield absorbs twice, 3rd absorb breaks it; broken shield is illegal.
s := R.init("");
var i = 0;
while (i < 3) {
  s := round(s, #load, #load); // p1 gains ammo
  s := round(s, #shoot, #shield); // p2 absorbs
  i += 1;
};
assert s.p2.shieldHits == 3;
switch (R.validate(s, #p2, #shield)) {
  case (?_) {};
  case null Runtime.trap("broken shield must be illegal");
};
// Undefended 4th shot kills.
s := round(s, #load, #load);
let kill = R.resolve(s, #shoot, #load);
switch (kill.verdict) {
  case (?#p1Wins) {};
  case (_) Runtime.trap("no defense = death");
};
Debug.print("3. shield capacity + break OK");

// 4. Laser: 5 consecutive loads charge it; it pierces shield AND mirror.
func charged() : R.State {
  var st = R.init("");
  var j = 0;
  while (j < 5) { st := round(st, #load, #shield); j += 1 }; // p2 shields (absorbs nothing)
  assert st.p1.charge == 5;
  st;
};
let vsShield = R.resolve(charged(), #shoot, #shield);
switch (vsShield.verdict) {
  case (?#p1Wins) {};
  case (_) Runtime.trap("laser must pierce shield");
};
let vsMirror = R.resolve(charged(), #shoot, #mirror);
switch (vsMirror.verdict) {
  case (?#p1Wins) {};
  case (_) Runtime.trap("laser must pierce mirror");
};
Debug.print("4. laser pierces shield and mirror OK");

// 5. Charge resets on any non-load action.
s := R.init("");
var k = 0;
while (k < 4) { s := round(s, #load, #load); k += 1 };
assert s.p1.charge == 4;
s := round(s, #shield, #load); // breaks the streak
assert s.p1.charge == 0;
s := round(s, #load, #load);
assert s.p1.charge == 1; // counting restarts
Debug.print("5. charge streak reset OK");

// 6. validate rejects 0-ammo shoot and 0-mirror mirror.
s := R.init("");
switch (R.validate(s, #p1, #shoot)) {
  case (?_) {};
  case null Runtime.trap("0-ammo shoot must be illegal");
};
var s2 = R.init("");
var m = 0;
while (m < 3) { s2 := round(s2, #load, #mirror); m += 1 };
assert s2.p2.mirrors == 0;
switch (R.validate(s2, #p2, #mirror)) {
  case (?_) {};
  case null Runtime.trap("0-mirror must be illegal");
};
Debug.print("6. resource validation OK");

Debug.print("ALL RULES CHECKS PASSED");
