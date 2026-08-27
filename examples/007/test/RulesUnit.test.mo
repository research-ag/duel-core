// Unit checks for the pure 007 rules that RulesTest.mo's scenarios miss:
// the p2-as-shooter half of `resolve`, the laser-vs-laser and laser-vs-shot
// endings, the narration/lastRound bookkeeping, and `validate` driven from
// synthetic states that normal play cannot reach.
// Run: moc -r --package core <core/src> --package duel-game-core <backend/src> test/RulesUnit.test.mo
import R "../Duel007Rules";
import TP "mo:duel-game-core"; // Verdict lives in the engine, not the rules
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text"; // enables Text.contains dot notation

// Shorthand: run one round, trap if it ended unexpectedly.
func round(s : R.State, a1 : R.Action, a2 : R.Action) : R.State {
  let r = R.resolve(s, a1, a2);
  switch (r.verdict) { case null {}; case (?_) Runtime.trap("unexpected end") };
  r.state;
};

func narrationOf(s : R.State) : Text = switch (s.lastRound) {
  case (?rd) rd.narration;
  case null Runtime.trap("round did not record a narration");
};

func alive(r : { state : R.State; verdict : ?TP.Verdict }, msg : Text) {
  switch (r.verdict) { case null {}; case (?_) Runtime.trap(msg) };
};

// ── 1. init() is a clean slate, and spec() hands out the same rules ────────
let s0 = R.init();
assert s0.p1.ammo == 0 and s0.p1.shieldHits == 0;
assert s0.p1.mirrors == 3 and s0.p1.charge == 0;
assert s0.p2.ammo == 0 and s0.p2.shieldHits == 0;
assert s0.p2.mirrors == 3 and s0.p2.charge == 0;
switch (s0.lastRound) {
  case null {};
  case (?_) Runtime.trap("a fresh game has no previous round");
};
let sp = R.spec();
let s1 = sp.init();
assert s1.p1.mirrors == 3 and s1.p2.mirrors == 3;
switch (sp.validate(s1, #p1, #shoot)) {
  case (?_) {};
  case null Runtime.trap("spec.validate must be the module's validate");
};
alive(sp.resolve(s1, #load, #load), "spec.resolve must be the module's resolve");
Debug.print("1. init + spec wiring OK");

// ── 2. Seat names ─────────────────────────────────────────────────────────
assert R.agentName(#p1) == "BOND";
assert R.agentName(#p2) == "SILVA";
Debug.print("2. agentName OK");

// ── 3. Symmetry: p2 shooting exercises the mirrored half of `resolve` ──────
var s = R.init();
s := round(s, #load, #load); // both hold 1 ammo

let p2Kills = R.resolve(s, #load, #shoot);
switch (p2Kills.verdict) {
  case (?#p2Wins) {};
  case (_) Runtime.trap("an undefended p1 must die to p2's shot");
};
let p2Reflected = R.resolve(s, #mirror, #shoot);
switch (p2Reflected.verdict) {
  case (?#p1Wins) {};
  case (_) Runtime.trap("p1's mirror must kill the p2 shooter");
};
assert p2Reflected.state.p1.mirrors == 2;
let p2Absorbed = R.resolve(s, #shield, #shoot);
alive(p2Absorbed, "p1's shield must survive the first hit");
assert p2Absorbed.state.p1.shieldHits == 1;
assert p2Absorbed.state.p2.ammo == 0; // the shot cost p2 its round's ammo
Debug.print("3. p2-as-shooter symmetry OK");

// ── 4. Laser vs laser → mutual annihilation ───────────────────────────────
s := R.init();
var i = 0;
while (i < 5) { s := round(s, #load, #load); i += 1 };
assert s.p1.charge == 5 and s.p2.charge == 5;
let bothLasers = R.resolve(s, #shoot, #shoot);
switch (bothLasers.verdict) {
  case (?#draw) {};
  case (_) Runtime.trap("laser vs laser must draw");
};
assert narrationOf(bothLasers.state).contains(#text "LASERS");
Debug.print("4. laser vs laser draw OK");

// ── 5. Laser vs a normal shot → both die (the shot was already in flight) ──
s := R.init();
s := round(s, #load, #load);   // p2: ammo 1, charge 1
s := round(s, #load, #shield); // p2's streak breaks; p1 keeps loading
s := round(s, #load, #load);
s := round(s, #load, #load);
s := round(s, #load, #load);
assert s.p1.charge == 5; // p1 is charged
assert s.p2.charge == 3; // p2 is not
assert s.p2.ammo == 4;   // …but p2 can still fire a normal shot
let mixed = R.resolve(s, #shoot, #shoot);
switch (mixed.verdict) {
  case (?#draw) {};
  case (_) Runtime.trap("a laser does not outrun a shot already fired");
};
let mixedText = narrationOf(mixed.state);
assert mixedText.contains(#text "BOND fires LASER!");
assert mixedText.contains(#text "SILVA shoots.");
assert mixedText.contains(#text "standoff");
assert not mixedText.contains(#text "LASERS"); // only one laser was fired
Debug.print("5. laser vs normal shot OK");

// ── 6. A mirror is spent even when no shot arrives ────────────────────────
let wasted = R.resolve(R.init(), #load, #mirror);
alive(wasted, "a mirror alone ends nothing");
assert wasted.state.p2.mirrors == 2;
assert wasted.state.p2.charge == 0;
Debug.print("6. mirror consumed without a shot OK");

// ── 7. The 3rd absorb saves the defender AND breaks the shield ────────────
s := R.init();
i := 0;
while (i < 2) {
  s := round(s, #load, #load);
  s := round(s, #shoot, #shield);
  i += 1;
};
assert s.p2.shieldHits == 2;
s := round(s, #load, #load);
let breaks = R.resolve(s, #shoot, #shield);
alive(breaks, "the 3rd absorb still saves the defender");
assert breaks.state.p2.shieldHits == 3;
assert narrationOf(breaks.state).contains(#text "BREAKS");
switch (R.validate(breaks.state, #p2, #shield)) {
  case (?_) {};
  case null Runtime.trap("a broken shield must not be raisable");
};
Debug.print("7. shield break boundary + narration OK");

// ── 8. Every round records the moves that produced it ─────────────────────
let logged = R.resolve(R.init(), #load, #shield);
switch (logged.state.lastRound) {
  case (?rd) {
    assert rd.p1Action == #load;
    assert rd.p2Action == #shield;
    assert rd.narration.contains(#text "BOND loads.");
    assert rd.narration.contains(#text "SILVA raises shield.");
  };
  case null Runtime.trap("resolve must record lastRound");
};
Debug.print("8. lastRound bookkeeping OK");

// ── 9. validate on a synthetic depleted state — including the charged-but-
//       empty gun, which ordinary play cannot produce ──────────────────────
let depleted : R.State = {
  p1 = { ammo = 0; shieldHits = 3; mirrors = 0; charge = 5 };
  p2 = { ammo = 0; shieldHits = 3; mirrors = 0; charge = 0 };
  lastRound = null;
};
// LOAD is the one move that is always available.
switch (R.validate(depleted, #p1, #load)) {
  case null {};
  case (?_) Runtime.trap("LOAD must always be legal");
};
switch (R.validate(depleted, #p2, #load)) {
  case null {};
  case (?_) Runtime.trap("LOAD must always be legal");
};
// A charged laser fires with no ammo; an uncharged gun does not.
switch (R.validate(depleted, #p1, #shoot)) {
  case null {};
  case (?_) Runtime.trap("a charged laser needs no ammo");
};
switch (R.validate(depleted, #p2, #shoot)) {
  case (?_) {};
  case null Runtime.trap("no ammo and no charge = no shot");
};
// Broken shields and spent mirrors are refused on both seats.
switch (R.validate(depleted, #p1, #shield)) {
  case (?_) {};
  case null Runtime.trap("broken shield must be illegal");
};
switch (R.validate(depleted, #p2, #mirror)) {
  case (?_) {};
  case null Runtime.trap("spent mirror must be illegal");
};
Debug.print("9. validate on depleted state OK");

// ── 10. A round with no shots changes nothing but the bookkeeping ─────────
let quiet = R.resolve(R.init(), #shield, #mirror);
alive(quiet, "nobody shot — nobody dies");
assert quiet.state.p1.ammo == 0 and quiet.state.p1.charge == 0;
assert quiet.state.p1.shieldHits == 0; // raising a shield is not a hit
assert quiet.state.p2.mirrors == 2;
Debug.print("10. quiet round OK");

Debug.print("ALL RULES UNIT CHECKS PASSED");
