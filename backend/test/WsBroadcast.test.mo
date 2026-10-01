// Unit checks for `ws.mo`'s `rematchOpenedLobby`: a rematch left unreserved
// by a departed partner must be broadcast to every browsing session.
import Rules "FakeGame";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import Registry "../src/registry";
import Ws "../src/ws";

type Reg = TP.Registry<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60 s
let T0 : Int = 1_000_000_000_000;

func fresh() : Reg {
  let r = Registry.new<Rules.State, Rules.Action>();
  r.setTimeouts(TIMEOUT, TIMEOUT);
  r;
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(spec, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};
func genOf(reg : Reg, at : Int, session : Text) : Nat = switch (atTableView(reg, at, session)) {
  case (#stagingYou v) v.gen;
  case (#inGame v) v.gen;
  case (#debrief v) v.gen;
  case (_) Runtime.trap("genOf: " # session # " is not in a live phase");
};
func turnOf(reg : Reg, at : Int, session : Text) : Nat = switch (atTableView(reg, at, session)) {
  case (#inGame v) v.turn;
  case (_) Runtime.trap("turnOf: " # session # " is not in an active game");
};

func playToDebrief(reg : Reg, id : TP.TableId) {
  ignore ok(reg.joinTable(spec, T0, "b", id, #p2, null), "b joins; game live");
  ignore ok(reg.submit(spec, T0, "a", genOf(reg, T0, "a"), turnOf(reg, T0, "a"), #gather), "a gathers");
  ignore ok(reg.submit(spec, T0, "b", genOf(reg, T0, "b"), turnOf(reg, T0, "b"), #gather), "b gathers");
  ignore ok(reg.submit(spec, T0, "a", genOf(reg, T0, "a"), turnOf(reg, T0, "a"), #attack), "a attacks");
  ignore ok(reg.submit(spec, T0, "b", genOf(reg, T0, "b"), turnOf(reg, T0, "b"), #gather), "b gathers again; a wins, both land in debrief");
};

// ── 1. no table at all: null id, or an id naming nothing ───────────────────
do {
  let reg = fresh();
  assert not Ws.rematchOpenedLobby(reg, null);
  assert not Ws.rematchOpenedLobby(reg, ?9999);
  Debug.print("1. no table (null id, or a bogus one) never opens the lobby OK");
};

// ── 2. the normal rematch outcome: the partner is still around, so the new
//      staging comes back RESERVED for them ─────────────────────────────────
do {
  let reg = fresh();
  let id = ok(reg.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
  playToDebrief(reg, id);
  ignore ok(reg.rematch(spec, T0, "a"), "a requests a rematch; b is still right there");
  assert not Ws.rematchOpenedLobby(reg, ?id);
  Debug.print("2. a rematch reserved for a still-present partner doesn't open the lobby OK");
};

// ── 3. the actual bug: the partner already left their own debrief before the
//      rematch request ──────────────────────────────────────────────────────
do {
  let reg = fresh();
  let id = ok(reg.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
  playToDebrief(reg, id);
  ignore ok(reg.leave(T0, "a", genOf(reg, T0, "a")), "a returns to the lobby first");
  ignore ok(reg.rematch(spec, T0, "b"), "b requests a rematch after a already left");
  assert Ws.rematchOpenedLobby(reg, ?id);
  Debug.print("3. a rematch left unreserved by a departed partner DOES open the lobby OK");
};

// ── 4. accepting a live reservation starts the game outright ───────────────
do {
  let reg = fresh();
  let id = ok(reg.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
  playToDebrief(reg, id);
  ignore ok(reg.rematch(spec, T0, "a"), "a requests a rematch, reserving b's old seat");
  ignore ok(reg.rematch(spec, T0, "b"), "b accepts; the game starts outright");
  assert not Ws.rematchOpenedLobby(reg, ?id);
  Debug.print("4. accepting a live reservation (now #active) doesn't open the lobby OK");
};

// ── 5. an idempotent re-click on an ALREADY-unreserved staging (no new
//      staging was created) ─────────────────────────────────────────────────
do {
  let reg = fresh();
  let id = ok(reg.createTable(spec, T0, "a", #p1, #open, ""), "a creates a table");
  playToDebrief(reg, id);
  ignore ok(reg.leave(T0, "a", genOf(reg, T0, "a")), "a returns to the lobby first");
  ignore ok(reg.rematch(spec, T0, "b"), "b requests a rematch after a already left");
  ignore ok(reg.rematch(spec, T0, "b"), "b's own idempotent re-click");
  assert Ws.rematchOpenedLobby(reg, ?id);
  Debug.print("5. an idempotent re-click on an already-open staging still reads as open OK");
};

Debug.print("ALL WS BROADCAST CHECKS PASSED");
