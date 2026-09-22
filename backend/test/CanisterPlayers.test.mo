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
// Kept well under CLAIM_TIMEOUT (unlike Lobby.test.mo/Engine.test.mo,
// this suite goes through `canister_players.mo`'s own ops, several of
// which stamp `lastActivity` via their OWN internal `Time.now()` call —
// a fixed, small constant under the `moc -r` interpreter, not real wall
// time (this module plays the host's own role and calls `Time.now()`
// itself, same documented exception `ws.mo`/`actor_mixin.mo` already
// are — see canister_players.mo's own doc header). A `T0` comparable in
// magnitude to that keeps every claim-win/idle-timeout check in this
// file measuring genuine elapsed time relative to it, not an arbitrary
// gap that would read as "already long overdue" the moment ANY
// nudge-triggered move lands.
let T0 : Int = 1_000_000_000;

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
let sidBot2 = CanisterPlayers.sidForCanister(bot2);

// ── 1. sidForCanister / isCanisterSession ───────────────────────────────
assert sidBot1 == "cp:" # bot1.toText();
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
let genBefore = switch (atTableView(reg9, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
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

// ── 10. Flow 2, eager dual-seat assignment (registry.createTableReserving,
//          see ../../CLAUDE.md's "Canister players" note): a canister seated
//          this way is ALREADY due the instant the table exists — no
//          joinTable of its own, no eager-trigger call needed at all, just
//          the next ordinary nudge tick ────────────────────────────────────
let reg10 = fresh();
let counter10 = newAfterMutationCounter();
let cp10 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg10, stubAfterMutation(counter10), constantBot(#gather));
ignore ok(reg10.createTableReserving(spec, T0, "human", #p1, #open, sidBot1), "human creates a table, atomically reserving bot1 for #p2");
switch (atTableView(reg10, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // due immediately — bot1 never called joinTable
  case (_) Runtime.trap("bot1 should already be #inGame, eagerly seated");
};
await* cp10.nudge(T0);
switch (atTableView(reg10, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // the ordinary nudge tick picked it up, same as any other due canister seat
  case (_) Runtime.trap("bot1 should still be in-game");
};
switch (atTableView(reg10, T0, "human")) {
  case (#inGame v) assert v.oppSubmitted;
  case (_) Runtime.trap("human should see bot1's move landed");
};
Debug.print("10. a canister eagerly seated via createTableReserving is due from the start, no joinTable needed OK");

// ── 11. claimWin / reset forward correctly, routing per-table exactly like
//          leave above (only ever "my own table," never an arbitrary one
//          by id — see `Attached`'s own doc on why) ────────────────────────
let reg11 = fresh();
let counter11 = newAfterMutationCounter();
let cp11 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg11, stubAfterMutation(counter11), constantBot(#gather));
expectErr(await* cp11.claimWin(bot1, 0), "bot1 (not seated anywhere) tries to claim a win");
expectErr(await* cp11.reset(bot1, 0), "bot1 (not seated anywhere) tries to reset");
let id11 = ok(await* cp11.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(reg11.joinTable(spec, T0, "human", id11, #p2, null), "human joins; game live");
await* cp11.nudge(T0); // bot1 gathers; now waiting on human
let g11 = switch (atTableView(reg11, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
switch (await* cp11.claimWin(bot1, g11)) {
  case (#err(#notOverdue _)) {};
  case (other) Runtime.trap("bot1's own claim window hasn't elapsed yet, got " # debug_show (other));
};
ok(await* cp11.reset(bot1, g11), "bot1 resets its own live game — a shared #aborted debrief, same as leave");
switch (atTableView(reg11, T0, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("bot1's own reset (while seated) should abort as leave does");
  };
  case (_) Runtime.trap("bot1 should be in the shared debrief its own reset just created");
};
Debug.print("11. claimWin / reset forward correctly and route per-table OK");

// ── 12. unattended, canister-vs-canister: bot2 never answers at all — once
//          bot1's own move has sat pending against bot2's silence for
//          longer than claimTimeoutNs, the NEXT ordinary nudge tick claims
//          the win on bot1's behalf automatically. No human is ever
//          involved — the milestone-04 "two bots finish a game with no
//          human ever present" case ────────────────────────────────────────
// One shared `callBot`, dispatching per-SESSION rather than per-`attach`
// (unlike test 7's "a fresh attach stands in for a bot that starts
// answering" trick) — a real deployment wires exactly ONE `attach` per
// host actor, whose own `callBot` closure is what tells two different
// canister players apart in the first place (by looking at which
// principal `session` actually names); reusing test 7's per-attach
// pattern here would let bot1's OWN join-triggered eager check run
// through bot2's silent closure instead of its own.
func perSessionBot(silent : TP.SessionId) : (TP.SessionId, TP.MoveRequest<Rules.State>, (?Rules.Action) -> async* ()) -> async* () {
  func(session : TP.SessionId, _req : TP.MoveRequest<Rules.State>, k : (?Rules.Action) -> async* ()) : async* () {
    if (session == silent) { await* k(null) } else { await* k(?#gather) };
  };
};
let reg12 = fresh();
let counter12 = newAfterMutationCounter();
let cp12 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg12, stubAfterMutation(counter12), perSessionBot(sidBot2));
let id12 = ok(await* cp12.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(await* cp12.joinTable(bot2, id12, #p2, null), "bot2 joins; game starts — bot1's own eager join-trigger gathers, bot2 stays silent");
switch (atTableView(reg12, T0, sidBot1), atTableView(reg12, T0, sidBot2)) {
  case (#inGame v1, #inGame v2) {
    assert v1.youSubmitted;
    assert not v2.youSubmitted;
  };
  case (_, _) Runtime.trap("bot1 should be waiting, bot2 should still be due");
};
let PAST_CLAIM : Int = T0 + CLAIM_TIMEOUT + 1_000_000_000; // safely past bot1's own claim window
await* cp12.nudge(PAST_CLAIM); // bot2 is asked again (still silent, no progress) AND bot1's stall is now claimable
switch (atTableView(reg12, PAST_CLAIM, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("bot1's own automatic claim should credit p1");
  };
  case (other) Runtime.trap("expected a #claimed debrief, got " # debug_show (other));
};
// Both seats are still pinned to the just-ended table — neither has acked
// its own side of the shared debrief yet.
expectErr(await* cp12.createTable(bot1, #p1, #open), "bot1 should still be pinned to the debrief its own claim just created");
expectErr(await* cp12.createTable(bot2, #p1, #open), "bot2 should still be pinned too");
// Nobody's around to decide on a rematch in an all-canister match — the
// NEXT nudge tick acks BOTH seats immediately, with no deadlock waiting
// on each other's own ack (see `maybeAckDebrief`'s own doc).
await* cp12.nudge(PAST_CLAIM);
ignore ok(await* cp12.createTable(bot1, #p1, #open), "bot1 should be free immediately, no deadlock waiting on bot2");
ignore ok(await* cp12.createTable(bot2, #p1, #open), "bot2 should be free immediately too");
Debug.print("12. an unattended canister-vs-canister match finishes via nudge's own automatic claim-win, no human involved OK");

// ── 13. the reported bug this fix addresses: a game ending via a HUMAN's
//          own action (never routed through canister_players.mo at all)
//          leaves a canister seat pinned to the just-ended table, refusing
//          a fresh `createTable` for that same `cp:` session — `nudge`
//          must free it once nobody's left who could still want a
//          rematch, but NOT a moment before, so a still-deciding human
//          partner's own rematch window is never cut short ─────────────
let reg13 = fresh();
let counter13 = newAfterMutationCounter();
let cp13 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg13, stubAfterMutation(counter13), constantBot(#gather));
let id13 = ok(await* cp13.createTable(bot1, #p1, #open), "bot1 creates a table");
ignore ok(reg13.joinTable(spec, T0, "human", id13, #p2, null), "human joins; game live");
let genAbort13 = switch (atTableView(reg13, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
// The human forfeits/leaves outright — a shared #aborted debrief, exactly
// like the reported bug (`ws.mo` is what a real human's frontend goes
// through; a direct `reg13.leave` call stands in for it here, same as
// test 3's own doc explains for why a human's own actions never route
// through `canister_players.mo`).
ok(reg13.leave(T0, "human", genAbort13), "human forfeits — bot1's side of the debrief is never told");
expectErr(await* cp13.createTable(bot1, #p1, #open), "bot1 should be pinned to its own unacked debrief, same as the reported bug");
await* cp13.nudge(T0);
// Still pinned — the human hasn't acked THEIR side yet, so they might
// still rematch; freeing bot1 now would silently break that option.
expectErr(await* cp13.createTable(bot1, #p1, #open), "bot1 should stay pinned while its human partner could still rematch");
ignore ok(reg13.leave(T0, "human", genAbort13), "human acks their own debrief too (idempotent gen, same as leave's own doc) — no rematch coming");
await* cp13.nudge(T0);
// Freed — nothing's left for bot1 to wait on, no idle-timeout wait needed.
ignore ok(await* cp13.createTable(bot1, #p1, #open), "bot1 should be free the moment its human partner is gone for good");
Debug.print("13. a canister seat's own finished debrief only auto-acks once its human partner is gone for good OK");

Debug.print("ALL CANISTER-PLAYERS CHECKS PASSED");
