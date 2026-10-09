// One short narrative through the real engine on an Instructables table:
// join, a few real opening moves, then the live position is seeded via
// `Table.phase` to one attack from finishing.
import TP "mo:duel-game-core";
import Rng "mo:duel-game-core/rng";
import Table "mo:duel-game-core/table";
import Rules "../src/ChopsticksRules";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let rng = Rng.new(42);

type Tbl = TP.Table<Rules.State, Rules.Action, Rules.Options>;

let spec = Rules.spec;
let now : Int = 1_000_000_000_000;

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

let t = Table.new<Rules.State, Rules.Action, Rules.Options>(60_000_000_000, 15_000_000_000, #open, "test", #instructables);

// ── 1. join seats p1/p2, p1 moves first ────────────────────────────────────
ignore ok(t.join(spec, rng, now, "a", #p1), "a joins");
switch (ok(t.join(spec, rng, now, "b", #p2), "b joins")) {
  case (#started _) {};
  case (_) Runtime.trap("b's join should complete the pair and start the game");
};
Debug.print("1. join OK");

// ── 2. genuine opening moves resolve through the real position ─────────────
func genOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in an active game");
};
func turnOf(session : Text) : Nat = switch (t.status(spec, now, session)) {
  case (#inGame v) v.step;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};
ignore ok(t.submit(spec, rng, now, "a", genOf("a"), turnOf("a"), #attack { from = #l; to = #l }), "a taps 1 onto b's left");
ignore ok(t.submit(spec, rng, now, "b", genOf("b"), turnOf("b"), #attack { from = #l; to = #r }), "b taps 2 onto a's right");
ignore ok(t.submit(spec, rng, now, "a", genOf("a"), turnOf("a"), #attack { from = #r; to = #l }), "a taps 3 onto b's left: 2 + 3 = 5, out");
switch (t.status(spec, now, "b")) {
  case (#inGame v) {
    assert v.step == 3;
    assert v.game.p1 == { l = 1; r = 3 };
    assert v.game.p2 == { l = 0; r = 1 };
  };
  case (_) Runtime.trap("b should be on turn");
};
Debug.print("2. opening moves through the real position OK");

// ── 3. seed the position one attack from a finish, then play it for real:
//      b's last live hand holds 4 and a taps a 1 onto it (exactly 5) ────────
switch (t.phase) {
  case (#active g) {
    t.phase := #active {
      g with
      game = { g.game with p1 = { l = 1; r = 2 }; p2 = { l = 0; r = 4 } };
    };
  };
  case (_) Runtime.trap("expected a live game to seed");
};
ignore ok(t.submit(spec, rng, now, "b", genOf("b"), turnOf("b"), #attack { from = #r; to = #r }), "b taps 4 onto a's right: 2 + 4 = 6 wraps to 1");
switch (ok(t.submit(spec, rng, now, "a", genOf("a"), turnOf("a"), #attack { from = #l; to = #r }), "a's finishing attack")) {
  case (#gameEnded r) { assert r.verdict == #p1Wins };
  case (_) Runtime.trap("putting b's last hand out must end the match");
};
switch (t.status(spec, now, "b")) {
  case (#debrief d) switch (d.end) {
    case (#finished(#p1Wins)) {};
    case (_) Runtime.trap("expected a #finished(#p1Wins) debrief");
  };
  case (_) Runtime.trap("b should land in a shared debrief too");
};
Debug.print("3. finishing attack ends the match through the real engine OK");

Debug.print("ALL CHOPSTICKS LIFECYCLE CHECKS PASSED");
