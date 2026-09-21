// Per-operation checks for `canister_players.mo` — the `cp:` sid
// namespace, the five table-lifecycle ops, and the `notifyAndApply`/
// `nudge` call/response protocol. Plugged-in rules: FakeGame.mo (the same
// trivial `#simultaneous` fixture Engine.test.mo/Lobby.test.mo use).
// `afterMutation` is stubbed here (just counts calls) rather than a real
// `Ws.attach` — the full `IcWebSocketCdk` actor machinery isn't
// exercisable in this interpreter harness, same caveat Hub.test.mo
// documents for `ws.mo` itself; what's under test here is this module's
// OWN orchestration (due-seat detection, retry-on-illegal-move, the
// in-flight guard clearing correctly), not the push transport.
// Run: moc -r --package core <core/src> test/CanisterPlayers.test.mo
import Debug "mo:core/Debug";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import CanisterPlayers "../src/canister_players";
import Registry "../src/registry";
import Rules "FakeGame";

type Reg = TP.Registry<Rules.State, Rules.Action>;

let spec = Rules.spec();

let TIMEOUT : Int = 60_000_000_000; // 60 s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20 s
let T0 : Int = 1_000_000_000_000;

func fresh() : Reg = Registry.new<Rules.State, Rules.Action>(TIMEOUT, CLAIM_TIMEOUT);

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (reg.status(spec, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");
let sidBot1 = CanisterPlayers.sidForCanister(bot1);

// ── 1. sidForCanister / isCanisterSession ───────────────────────────────
assert sidBot1 == "cp:" # Principal.toText(bot1);
assert CanisterPlayers.isCanisterSession(sidBot1);
assert not CanisterPlayers.isCanisterSession("ii:someone");
assert not CanisterPlayers.isCanisterSession("an:someone");
Debug.print("1. sidForCanister / isCanisterSession OK");

// ── shared test doubles ─────────────────────────────────────────────────

/// Counts every push this stub is asked to run — stands in for
/// `Ws.Attached.afterMutation` (see this file's own header for why the
/// real one isn't exercisable here).
func newAfterMutationCounter() : { var calls : Nat } = { var calls = 0 };

func stubAfterMutation(counter : { var calls : Nat }) : (Int, TP.SessionId, ?Nat64, ?TP.TableId, Bool) -> async* () {
  func(_now : Int, _sid : TP.SessionId, _reqId : ?Nat64, _id : ?TP.TableId, _broadcast : Bool) : async* () {
    counter.calls += 1;
  };
};

/// A bot that always plays the same fixed action.
func constantBot(move : Rules.Action) : (TP.SessionId, TP.MoveRequest<Rules.State>, (?Rules.Action) -> async* ()) -> async* () {
  func(_session : TP.SessionId, _req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(?move);
  };
};

/// A bot that plays `first` on its first call, `rest` on every call after.
func retryingBot(first : Rules.Action, rest : Rules.Action) : (TP.SessionId, TP.MoveRequest<Rules.State>, (?Rules.Action) -> async* ()) -> async* () {
  var calls = 0;
  func(_session : TP.SessionId, _req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
    calls += 1;
    await* k(?(if (calls == 1) first else rest));
  };
};

/// A bot that traps/errors every time — `notifyAndApply` treats this
/// identically to `k(null)`, the outcome a host's own `try`/`catch`
/// around the real inter-canister call would produce.
func silentBot() : (TP.SessionId, TP.MoveRequest<Rules.State>, (?Rules.Action) -> async* ()) -> async* () {
  func(_session : TP.SessionId, _req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(null);
  };
};

// ── 2. createTable / joinTable seat a canister exactly like a human ─────
let reg2 = fresh();
let counter2 = newAfterMutationCounter();
let cp2 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg2, stubAfterMutation(counter2), constantBot(#gather));
let id2 = ok(await* cp2.createTable(bot1, #p1, #open), "bot1 creates a table");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#stagingYou v) assert v.seat == #p1;
  case (_) Runtime.trap("bot1 should be staging");
};
assert counter2.calls == 1; // afterMutation ran once, for the create
Debug.print("2. createTable seats the canister under its own cp: sid OK");

// ── 3. a human joining a bot's table doesn't move on its own — a human's
//        own action never eagerly triggers a bot (see this module's own
//        doc header: ws.mo stays completely unchanged); `nudge` is what
//        catches it, same as a periodic timer tick would ───────────────
ignore ok(reg2.joinTable(spec, T0, "human", id2, #p2, null), "human joins bot1's table directly (bypassing canister_players — as ws.mo would)");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // bot1 hasn't been asked yet
  case (_) Runtime.trap("bot1 should be in-game");
};
await* cp2.nudge(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // nudge asked bot1, which gathered
  case (_) Runtime.trap("bot1 should still be in-game");
};
switch (atTableView(reg2, T0, "human")) {
  case (#inGame v) assert v.oppSubmitted;
  case (_) Runtime.trap("human should see bot1's move landed");
};
Debug.print("3. nudge asks a due, idle canister seat and applies its reply OK");

// ── 4. nudge is idempotent once nobody's due — no double-submit, no trap ─
await* cp2.nudge(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("4. a second nudge with nobody due is a harmless no-op OK");

// ── 5. round resolution re-triggers: once the human moves too, the round
//        resolves and bot1 is due again for the NEXT round ─────────────
ignore ok(reg2.submit(spec, T0, "human", (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.gen; case (_) Runtime.trap("n/a") }), (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.turn; case (_) Runtime.trap("n/a") }), #gather), "human gathers too; round resolves");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // fresh round — bot1 is due again
  case (_) Runtime.trap("bot1 should still be in-game, next round");
};
await* cp2.nudge(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("5. a resolved round makes a canister seat due again, caught by the next nudge OK");

// ── 6. an illegal move is retried once, then the legal fallback lands ───
let reg6 = fresh();
let counter6 = newAfterMutationCounter();
// #attack is illegal at 0 resource (FakeGame's own rule) — the bot's
// first reply is always illegal here; the retry's #gather must be what
// actually lands.
let cp6 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg6, stubAfterMutation(counter6), retryingBot(#attack, #gather));
let id6 = ok(await* cp6.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(reg6.joinTable(spec, T0, "human", id6, #p2, null), "human joins");
await* cp6.nudge(T0);
switch (atTableView(reg6, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // the retried #gather landed
  case (_) Runtime.trap("bot1 should still be in-game after its retried move");
};
Debug.print("6. an illegal move is retried once and the legal reply is applied OK");

// ── 7. a bot that never answers leaves the round pending, not stuck — and
//        the in-flight flag clears so a LATER nudge can ask again once the
//        bot (or a fresh deploy of it) starts answering ─────────────────
let reg7 = fresh();
let counter7 = newAfterMutationCounter();
let cp7fail = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg7, stubAfterMutation(counter7), silentBot());
let id7 = ok(await* cp7fail.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(reg7.joinTable(spec, T0, "human", id7, #p2, null), "human joins");
await* cp7fail.nudge(T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // silence — nothing landed, no trap
  case (_) Runtime.trap("bot1 should still be in-game, still pending");
};
// A fresh `attach` over the SAME registry stands in for "the bot starts
// answering" (this module keeps no state of its own beyond the
// in-flight guard, which a failed attempt always clears — see
// `notifyAndApply`'s own doc) — nudging through it must still work.
let cp7ok = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg7, stubAfterMutation(counter7), constantBot(#gather));
await* cp7ok.nudge(T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game after finally answering");
};
Debug.print("7. a silent/trapping bot leaves the round pending, not stuck forever OK");

// ── 8. bot-vs-bot: the SECOND bot's own joinTable eagerly triggers BOTH
//        seats immediately — no nudge needed at all for the common case ─
let reg8 = fresh();
let counter8 = newAfterMutationCounter();
let cp8 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg8, stubAfterMutation(counter8), constantBot(#gather));
let id8 = ok(await* cp8.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(await* cp8.joinTable(bot2, id8, #p2, null), "bot2 joins; game starts");
switch (atTableView(reg8, T0, sidBot1)) {
  case (#inGame v) assert v.turn > 0; // both seats already moved and resolved a round
  case (_) Runtime.trap("bot1 should be in-game, at least one round in");
};
Debug.print("8. two canister seats joining each other eagerly resolve rounds with no human, no nudge OK");

// ── 9. leave / rematch / ackEnded forward correctly and derive the
//         session purely from the caller's own principal ───────────────
let reg9 = fresh();
let counter9 = newAfterMutationCounter();
let cp9 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg9, stubAfterMutation(counter9), constantBot(#gather));
let id9 = ok(await* cp9.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(reg9.joinTable(spec, T0, "human", id9, #p2, null), "human joins; game live");
let genBefore = switch (atTableView(reg9, T0, sidBot1)) { case (#inGame v) v.gen; case (_) Runtime.trap("n/a") };
ok(await* cp9.leave(bot1, genBefore), "bot1 leaves the live game — a shared #aborted debrief");
switch (atTableView(reg9, T0, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("bot1's own leave should abort as p1");
  };
  case (_) Runtime.trap("bot1 should be in the shared debrief it just created");
};
await* cp9.ackEnded(bot1);
switch (reg9.status(spec, T0, sidBot1)) {
  case (#browsing _) {};
  case (_) Runtime.trap("bot1 should be back to browsing after ackEnded");
};
expectErr(await* cp9.leave(bot1, 0), "bot1 (not seated anywhere) tries to leave again");
Debug.print("9. leave / ackEnded forward correctly, deriving the session from the caller's own principal OK");

Debug.print("ALL CANISTER-PLAYERS CHECKS PASSED");
