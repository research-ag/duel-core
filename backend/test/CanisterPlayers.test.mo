// Per-operation checks for `canister_players.mo` — the `cp:` sid
// namespace, the table-lifecycle ops, and the `notifyAndApply`/`settle`/
// `sweep`/`armClaimCheck` protocol. Plugged-in rules: FakeGame.mo.
// `afterMutation`/`armClaimCheck` are stubbed rather than real (see
// Hub.test.mo for why the full actor machinery isn't exercisable here).
// Run: moc -r --package core <core/src> test/CanisterPlayers.test.mo
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Int "mo:core/Int";
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
// canister-driven move lands.
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
// Every test below is the FIRST `createTable`/`createTableReserving` call
// on its own `fresh()` registry, so its own table always lands on id 1
// (`Registry.new`'s own `tableIdNonce` starts there) — these globals are
// valid for every single-table test in this file precisely because of
// that; test 16 (two live boards for the same bot1) derives its own
// per-board sessions locally instead, since id 1 no longer means "the"
// table there.
let sidBot1 = CanisterPlayers.sidForCanister(bot1, 1);
let sidBot2 = CanisterPlayers.sidForCanister(bot2, 1);

// ── 1. sidForCanister / isCanisterSession / principalOfCanisterSession ──
assert sidBot1 == "cp:" # bot1.toText() # ":1";
assert CanisterPlayers.isCanisterSession(sidBot1);
assert not CanisterPlayers.isCanisterSession("ii:someone");
assert not CanisterPlayers.isCanisterSession("an:someone");
// A different board for the SAME principal is a different session —
// the whole point of keying `sidForCanister` on `tableId` (see
// `canister_players.mo`'s own doc header) — and `principalOfCanisterSession`
// is its exact inverse.
assert CanisterPlayers.sidForCanister(bot1, 2) != sidBot1;
assert CanisterPlayers.principalOfCanisterSession(sidBot1) == bot1;
assert CanisterPlayers.principalOfCanisterSession(CanisterPlayers.sidForCanister(bot1, 2)) == bot1;
Debug.print("1. sidForCanister / isCanisterSession / principalOfCanisterSession OK");

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

func noopArm(_id : TP.TableId, _secs : Nat) : async* () {};

/// Records `armClaimCheck` calls for test 15 to inspect.
func newArmLog() : { var calls : [(TP.TableId, Nat)] } = { var calls = [] };
func spyArmClaimCheck(log : { var calls : [(TP.TableId, Nat)] }) : (TP.TableId, Nat) -> async* () {
  func(id : TP.TableId, secs : Nat) : async* () {
    log.calls := Array.concat(log.calls, [(id, secs)]);
  };
};

/// A bot that always plays the same fixed action.
func constantBot(move : Rules.Action) : (TP.SessionId, TP.MoveRequest<Rules.State, Rules.Action>, (?Rules.Action) -> async* ()) -> async* () {
  func(_session : TP.SessionId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(?move);
  };
};

/// A bot that plays `first` on its first call, `rest` on every call
/// after — and asserts the retry's own `req.retryReason` carries exactly
/// `expectedReason`, the rejection text `validate` returned for `first`,
/// proving `notifyAndApply` actually threads it through rather than just
/// asking again blind. The first call must see `retryReason == null` —
/// it's a fresh ask, not (yet) a retry.
func retryingBot(first : Rules.Action, rest : Rules.Action, expectedReason : Text) : (TP.SessionId, TP.MoveRequest<Rules.State, Rules.Action>, (?Rules.Action) -> async* ()) -> async* () {
  var calls = 0;
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    calls += 1;
    if (calls == 1) {
      assert req.retryReason == null;
      await* k(?first);
    } else {
      switch (req.retryReason) {
        case (?reason) assert reason == expectedReason;
        case null Runtime.trap("retry's own MoveRequest must carry the previous rejection reason");
      };
      await* k(?rest);
    };
  };
};

/// A bot that traps/errors every time — `notifyAndApply` treats this
/// identically to `k(null)`, the outcome a host's own `try`/`catch`
/// around the real inter-canister call would produce.
func silentBot() : (TP.SessionId, TP.MoveRequest<Rules.State, Rules.Action>, (?Rules.Action) -> async* ()) -> async* () {
  func(_session : TP.SessionId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    await* k(null);
  };
};

/// A bot that always plays `move`, recording every `MoveRequest` it was
/// ever handed (in call order) into `log.reqs` — used to inspect the new
/// `opponent`/`opponentLastMove`/`lastRoundDurationNs` fields a smarter
/// bot would key its own memory off (see test 17).
func newReqLog() : { var reqs : [TP.MoveRequest<Rules.State, Rules.Action>] } = {
  var reqs = [];
};
func capturingBot(move : Rules.Action, log : { var reqs : [TP.MoveRequest<Rules.State, Rules.Action>] }) : (TP.SessionId, TP.MoveRequest<Rules.State, Rules.Action>, (?Rules.Action) -> async* ()) -> async* () {
  func(_session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    log.reqs := Array.concat(log.reqs, [req]);
    await* k(?move);
  };
};

// ── 2. createTable / joinTable seat a canister exactly like a human ─────
let reg2 = fresh();
let counter2 = newAfterMutationCounter();
let cp2 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg2, stubAfterMutation(counter2), constantBot(#gather), noopArm);
let id2 = ok(await* cp2.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#stagingYou v) assert v.seat == #p1;
  case (_) Runtime.trap("bot1 should be staging");
};
assert counter2.calls == 1; // afterMutation ran once, for the create
Debug.print("2. createTable seats the canister under its own cp: sid OK");

// ── 3. a human joining a bot's table doesn't move on its own; sweep asks it ─
ignore ok(reg2.joinTable(spec, T0, "human", id2, #p2, null), "human joins bot1's table directly (bypassing canister_players — as ws.mo would)");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // bot1 hasn't been asked yet
  case (_) Runtime.trap("bot1 should be in-game");
};
await* cp2.sweep(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // sweep asked bot1, which gathered
  case (_) Runtime.trap("bot1 should still be in-game");
};
switch (atTableView(reg2, T0, "human")) {
  case (#inGame v) assert v.oppSubmitted;
  case (_) Runtime.trap("human should see bot1's move landed");
};
Debug.print("3. sweep asks a due, idle canister seat and applies its reply OK");

// ── 4. sweep is idempotent once nobody's due — no double-submit, no trap ─
await* cp2.sweep(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("4. a second sweep with nobody due is a harmless no-op OK");

// ── 5. round resolution re-triggers: once the human moves too, the round
//        resolves and bot1 is due again for the NEXT round ─────────────
ignore ok(reg2.submit(spec, T0, "human", (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.gen; case (_) Runtime.trap("n/a") }), (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.turn; case (_) Runtime.trap("n/a") }), #gather), "human gathers too; round resolves");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // fresh round — bot1 is due again
  case (_) Runtime.trap("bot1 should still be in-game, next round");
};
await* cp2.sweep(T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("5. a resolved round makes a canister seat due again, caught by the next sweep OK");

// ── 6. an illegal move is retried once, then the legal fallback lands —
//        and the retry's own MoveRequest carries validate's own rejection
//        reason, not just a blind re-ask ─────────────────────────────────
let reg6 = fresh();
let counter6 = newAfterMutationCounter();
// #attack is illegal at 0 resource (FakeGame's own rule) — the bot's
// first reply is always illegal here; the retry's #gather must be what
// actually lands. retryingBot itself asserts the retry's `retryReason`
// matches this exact text (see its own doc).
let cp6 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg6, stubAfterMutation(counter6), retryingBot(#attack, #gather, "No resource — GATHER first."), noopArm);
let id6 = ok(await* cp6.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg6.joinTable(spec, T0, "human", id6, #p2, null), "human joins");
await* cp6.sweep(T0);
switch (atTableView(reg6, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // the retried #gather landed
  case (_) Runtime.trap("bot1 should still be in-game after its retried move");
};
Debug.print("6. an illegal move is retried once, carrying validate's own rejection reason, and the legal reply is applied OK");

// ── 7. a bot that never answers leaves the round pending, not stuck — and
//        the in-flight flag clears so a LATER sweep can ask again once the
//        bot (or a fresh deploy of it) starts answering ─────────────────
let reg7 = fresh();
let counter7 = newAfterMutationCounter();
let cp7fail = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg7, stubAfterMutation(counter7), silentBot(), noopArm);
let id7 = ok(await* cp7fail.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg7.joinTable(spec, T0, "human", id7, #p2, null), "human joins");
await* cp7fail.sweep(T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // silence — nothing landed, no trap
  case (_) Runtime.trap("bot1 should still be in-game, still pending");
};
// A fresh `attach` over the SAME registry stands in for "the bot starts
// answering" (this module keeps no state of its own beyond the
// in-flight guard, which a failed attempt always clears — see
// `notifyAndApply`'s own doc) — nudging through it must still work.
let cp7ok = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg7, stubAfterMutation(counter7), constantBot(#gather), noopArm);
await* cp7ok.sweep(T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game after finally answering");
};
Debug.print("7. a silent/trapping bot leaves the round pending, not stuck forever OK");

// ── 8. bot-vs-bot: the SECOND bot's own joinTable eagerly triggers BOTH
//        seats immediately — no sweep needed at all for the common case ─
let reg8 = fresh();
let counter8 = newAfterMutationCounter();
let cp8 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg8, stubAfterMutation(counter8), constantBot(#gather), noopArm);
let id8 = ok(await* cp8.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(await* cp8.joinTable(bot2, id8, #p2, null), "bot2 joins; game starts");
switch (atTableView(reg8, T0, sidBot1)) {
  case (#inGame v) assert v.turn > 0; // both seats already moved and resolved a round
  case (_) Runtime.trap("bot1 should be in-game, at least one round in");
};
Debug.print("8. two canister seats joining each other eagerly resolve rounds with no human, no sweep OK");

// ── 9. leave / ackEnded forward correctly, deriving the session from the
//         caller's own principal AND the tableId it names ─────────────
let reg9 = fresh();
let counter9 = newAfterMutationCounter();
let cp9 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg9, stubAfterMutation(counter9), constantBot(#gather), noopArm);
let id9 = ok(await* cp9.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg9.joinTable(spec, T0, "human", id9, #p2, null), "human joins; game live");
let genBefore = switch (atTableView(reg9, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
ok(await* cp9.leave(bot1, id9, genBefore), "bot1 leaves the live game — a shared #aborted debrief");
switch (atTableView(reg9, T0, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("bot1's own leave should abort as p1");
  };
  case (_) Runtime.trap("bot1 should be in the shared debrief it just created");
};
await* cp9.ackEnded(bot1, id9);
switch (reg9.status(spec, T0, sidBot1)) {
  case (#browsing _) {};
  case (_) Runtime.trap("bot1 should be back to browsing after ackEnded");
};
expectErr(await* cp9.leave(bot1, id9, 0), "bot1 (not seated anywhere any more) tries to leave the same table again");
Debug.print("9. leave / ackEnded forward correctly, deriving the session from the caller's own principal and tableId OK");

// ── 10. Flow 2, eager dual-seat assignment (registry.createTableReserving,
//          see ../../CLAUDE.md's "Canister players" note): a canister seated
//          this way is ALREADY due the instant the table exists — no
//          joinTable of its own, no eager-trigger call needed at all, just
//          the next ordinary sweep call ────────────────────────────────────
let reg10 = fresh();
let counter10 = newAfterMutationCounter();
let cp10 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg10, stubAfterMutation(counter10), constantBot(#gather), noopArm);
ignore ok(reg10.createTableReserving(spec, T0, "human", #p1, #open, sidBot1, ""), "human creates a table, atomically reserving bot1 for #p2");
switch (atTableView(reg10, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // due immediately — bot1 never called joinTable
  case (_) Runtime.trap("bot1 should already be #inGame, eagerly seated");
};
await* cp10.sweep(T0);
switch (atTableView(reg10, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // the ordinary sweep call picked it up, same as any other due canister seat
  case (_) Runtime.trap("bot1 should still be in-game");
};
switch (atTableView(reg10, T0, "human")) {
  case (#inGame v) assert v.oppSubmitted;
  case (_) Runtime.trap("human should see bot1's move landed");
};
Debug.print("10. a canister eagerly seated via createTableReserving is due from the start, no joinTable needed OK");

// ── 11. claimWin / reset forward correctly, routing to whichever `tableId`
//          the caller names — a `tableId` bot1 was never actually seated
//          at just derives a session `registry.bySession` doesn't know
//          either, so the engine's own `#notSeated` falls out with no
//          special-casing here ─────────────────────────────────────────
let reg11 = fresh();
let counter11 = newAfterMutationCounter();
let cp11 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg11, stubAfterMutation(counter11), constantBot(#gather), noopArm);
expectErr(await* cp11.claimWin(bot1, 1, 0), "bot1 (not seated anywhere) tries to claim a win");
expectErr(await* cp11.reset(bot1, 1, 0), "bot1 (not seated anywhere) tries to reset");
let id11 = ok(await* cp11.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg11.joinTable(spec, T0, "human", id11, #p2, null), "human joins; game live");
await* cp11.sweep(T0); // bot1 gathers; now waiting on human
let g11 = switch (atTableView(reg11, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
switch (await* cp11.claimWin(bot1, id11, g11)) {
  case (#err(#notOverdue _)) {};
  case (other) Runtime.trap("bot1's own claim window hasn't elapsed yet, got " # debug_show (other));
};
ok(await* cp11.reset(bot1, id11, g11), "bot1 resets its own live game — a shared #aborted debrief, same as leave");
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
//          longer than claimTimeoutNs, the NEXT ordinary sweep call claims
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
func perSessionBot(silent : TP.SessionId) : (TP.SessionId, TP.MoveRequest<Rules.State, Rules.Action>, (?Rules.Action) -> async* ()) -> async* () {
  func(session : TP.SessionId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    if (session == silent) { await* k(null) } else { await* k(?#gather) };
  };
};
let reg12 = fresh();
let counter12 = newAfterMutationCounter();
let cp12 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg12, stubAfterMutation(counter12), perSessionBot(sidBot2), noopArm);
let id12 = ok(await* cp12.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(await* cp12.joinTable(bot2, id12, #p2, null), "bot2 joins; game starts — bot1's own eager join-trigger gathers, bot2 stays silent");
switch (atTableView(reg12, T0, sidBot1), atTableView(reg12, T0, sidBot2)) {
  case (#inGame v1, #inGame v2) {
    assert v1.youSubmitted;
    assert not v2.youSubmitted;
  };
  case (_, _) Runtime.trap("bot1 should be waiting, bot2 should still be due");
};
let PAST_CLAIM : Int = T0 + CLAIM_TIMEOUT + 1_000_000_000; // safely past bot1's own claim window
await* cp12.sweep(PAST_CLAIM); // bot2 is asked again (still silent, no progress) AND bot1's stall is now claimable
switch (atTableView(reg12, PAST_CLAIM, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("bot1's own automatic claim should credit p1");
  };
  case (other) Runtime.trap("expected a #claimed debrief, got " # debug_show (other));
};
// Both seats are still pinned to the just-ended table — neither has acked
// its own side of the shared debrief yet. A fresh `createTable` is no
// longer a valid probe for "still busy" here: it derives a session
// scoped to a BRAND-NEW `tableId` of its own (see `canister_players.mo`'s
// own doc header on per-board identity), entirely independent of this
// table's, so it would succeed regardless of this debrief's state — test
// 16 demonstrates that freedom directly. `status` on THIS table's own
// session is what actually reveals whether it's been acked yet.
switch (reg12.status(spec, PAST_CLAIM, sidBot1)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot1 should still be pinned to the debrief its own claim just created, got " # debug_show (other));
};
switch (reg12.status(spec, PAST_CLAIM, sidBot2)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot2 should still be pinned too, got " # debug_show (other));
};
// Nobody's around to decide on a rematch in an all-canister match — the
// NEXT sweep call acks BOTH seats immediately, with no deadlock waiting
// on each other's own ack (see `maybeAckDebrief`'s own doc).
await* cp12.sweep(PAST_CLAIM);
switch (reg12.status(spec, PAST_CLAIM, sidBot1)) {
  case (#browsing _) {};
  case (other) Runtime.trap("bot1 should be free immediately, no deadlock waiting on bot2, got " # debug_show (other));
};
switch (reg12.status(spec, PAST_CLAIM, sidBot2)) {
  case (#browsing _) {};
  case (other) Runtime.trap("bot2 should be free immediately too, got " # debug_show (other));
};
Debug.print("12. an unattended canister-vs-canister match finishes via sweep's own automatic claim-win, no human involved OK");

// ── 13. the reported bug this fix addresses: a game ending via a HUMAN's
//          own action (never routed through canister_players.mo at all)
//          leaves a canister seat pinned to the just-ended table — `sweep`
//          must free it once nobody's left who could still want a
//          rematch, but NOT a moment before, so a still-deciding human
//          partner's own rematch window is never cut short (probed via
//          `status` on bot1's OWN table-1 session — see test 12's own
//          note on why a fresh `createTable` no longer serves as a
//          "still busy" probe) ─────────────────────────────────────────
let reg13 = fresh();
let counter13 = newAfterMutationCounter();
let cp13 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg13, stubAfterMutation(counter13), constantBot(#gather), noopArm);
let id13 = ok(await* cp13.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
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
switch (reg13.status(spec, T0, sidBot1)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot1 should be pinned to its own unacked debrief, same as the reported bug, got " # debug_show (other));
};
await* cp13.sweep(T0);
// Still pinned — the human hasn't acked THEIR side yet, so they might
// still rematch; freeing bot1 now would silently break that option.
switch (reg13.status(spec, T0, sidBot1)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot1 should stay pinned while its human partner could still rematch, got " # debug_show (other));
};
ignore ok(reg13.leave(T0, "human", genAbort13), "human acks their own debrief too (idempotent gen, same as leave's own doc) — no rematch coming");
await* cp13.sweep(T0);
// Freed — nothing's left for bot1 to wait on, no idle-timeout wait needed.
switch (reg13.status(spec, T0, sidBot1)) {
  case (#browsing _) {};
  case (other) Runtime.trap("bot1 should be free the moment its human partner is gone for good, got " # debug_show (other));
};
Debug.print("13. a canister seat's own finished debrief only auto-acks once its human partner is gone for good OK");

// ── 14. settle asks a due seat for one table, without scanning the registry ─
let reg14 = fresh();
let counter14 = newAfterMutationCounter();
let cp14 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg14, stubAfterMutation(counter14), constantBot(#gather), noopArm);
let id14 = ok(await* cp14.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg14.joinTable(spec, T0, "human", id14, #p2, null), "human joins bot1's table directly, as ws.mo's own onSettled hook would observe");
await* cp14.settle(T0, id14);
switch (atTableView(reg14, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("14. settle asks a due canister seat for one specific table OK");

// ── 15. a waiting-but-not-overdue seat arms exactly one precisely-timed
//          claim-win wakeup; re-settling before it fires doesn't claim early ─
let reg15 = fresh();
let counter15 = newAfterMutationCounter();
let armLog15 = newArmLog();
let cp15 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg15, stubAfterMutation(counter15), constantBot(#gather), spyArmClaimCheck(armLog15));
let id15 = ok(await* cp15.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
ignore ok(reg15.joinTable(spec, T0, "human", id15, #p2, null), "human joins; game live, nobody due-asked yet");
assert armLog15.calls == [];
await* cp15.settle(T0, id15);
switch (atTableView(reg15, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted and not v.claimWinAvailable;
  case (_) Runtime.trap("bot1 should be waiting, not yet claimable");
};
assert armLog15.calls == [(id15, CLAIM_TIMEOUT.toNat() / 1_000_000_000)];
await* cp15.settle(T0, id15); // re-settling before the wakeup fires must not claim early
switch (atTableView(reg15, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted and not v.claimWinAvailable;
  case (_) Runtime.trap("bot1 should still be waiting, still not claimable");
};
let PAST_CLAIM15 : Int = T0 + CLAIM_TIMEOUT + 1_000_000_000;
await* cp15.sweep(PAST_CLAIM15); // stands in for the armed Timer firing
switch (atTableView(reg15, PAST_CLAIM15, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("bot1's own armed claim-check should credit p1");
  };
  case (other) Runtime.trap("expected a #claimed debrief, got " # debug_show (other));
};
Debug.print("15. a waiting-but-not-yet-overdue canister seat arms exactly one precisely-timed claim-win check OK");

// ── 16. the same bot1 principal plays TWO tables at once, each an
//          ordinary, fully independent session — the actual multi-board
//          capability `sidForCanister(p, tableId)` exists for (see
//          `canister_players.mo`'s own doc header). `sweep` settles both
//          in one pass with no cross-talk, and `leave` on ONE of the two
//          `tableId`s leaves only that board — the other stays live,
//          proving `tableId` really does disambiguate "which of my
//          several games" rather than just routing to some single
//          implicit one ───────────────────────────────────────────────
let reg16 = fresh();
let counter16 = newAfterMutationCounter();
let cp16 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg16, stubAfterMutation(counter16), constantBot(#gather), noopArm);
let idA16 = ok(await* cp16.createTable(bot1, #p1, #open, ""), "bot1 creates board A");
let idB16 = ok(await* cp16.createTable(bot1, #p1, #open, ""), "the SAME bot1 creates board B too — rejected under the old one-session-per-principal scheme, legal now");
assert idA16 != idB16;
let sidA16 = CanisterPlayers.sidForCanister(bot1, idA16);
let sidB16 = CanisterPlayers.sidForCanister(bot1, idB16);
assert sidA16 != sidB16;
ignore ok(reg16.joinTable(spec, T0, "humanA", idA16, #p2, null), "humanA joins board A");
ignore ok(reg16.joinTable(spec, T0, "humanB", idB16, #p2, null), "humanB joins board B");
await* cp16.sweep(T0); // one pass settles bot1's due move on BOTH boards
switch (atTableView(reg16, T0, sidA16), atTableView(reg16, T0, sidB16)) {
  case (#inGame vA, #inGame vB) {
    assert vA.youSubmitted;
    assert vB.youSubmitted;
  };
  case (_, _) Runtime.trap("bot1 should be waiting on both boards after one sweep");
};
let genA16 = switch (atTableView(reg16, T0, sidA16)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
ok(await* cp16.leave(bot1, idA16, genA16), "bot1 leaves board A only");
switch (atTableView(reg16, T0, sidA16)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("board A's own leave should abort as p1");
  };
  case (_) Runtime.trap("board A should be in the debrief bot1's own leave just created");
};
switch (atTableView(reg16, T0, sidB16)) {
  case (#inGame v) assert v.youSubmitted; // untouched — board A's leave had no effect here
  case (_) Runtime.trap("board B should still be live — bot1's board-A leave must not have touched it");
};
Debug.print("16. the same bot1 principal plays two tables at once, each an independent session, settled and left independently OK");

// ── 17. MoveRequest carries the opponent's own identity, their most
//          recently RESOLVED move, and how long the last round took —
//          the extra context a stateful bot needs to remember something
//          across calls (see `T.MoveRequest`'s own doc). All three are
//          absent on round 0's own ask (nobody's moved yet, no round has
//          resolved yet); once a real round resolves, `opponentLastMove`
//          carries exactly the opponent's own submitted move (read from
//          the OTHER seat's own slot — see `dueRequest`'s own doc) and
//          `lastRoundDurationNs` reads back exactly the wall-clock gap
//          between the round starting and its own completing submission
//          — both fully test-controlled here via explicit `now` values
//          on the human's own DIRECT engine calls (bot1's own replies
//          land at whatever `Time.now()` the interpreter returns
//          internally — see this file's own `T0` doc comment) ──────────
let reg17 = fresh();
let counter17 = newAfterMutationCounter();
let reqLog17 = newReqLog();
let cp17 = CanisterPlayers.attach<Rules.State, Rules.Action>(spec, reg17, stubAfterMutation(counter17), capturingBot(#gather, reqLog17), noopArm);
let id17 = ok(await* cp17.createTable(bot1, #p1, #open, ""), "bot1 creates a table");

let JOIN17 : Int = 5_000_000_000;
ignore ok(reg17.joinTable(spec, JOIN17, "human", id17, #p2, null), "human joins at a known time — starts round 0");
await* cp17.sweep(T0); // bot1 is due for round 0
assert reqLog17.reqs.size() == 1;
let req0_17 = reqLog17.reqs[0];
assert req0_17.turn == 0;
assert req0_17.opponent == "human";
assert req0_17.opponentLastMove == null; // nobody has moved yet this match
assert req0_17.lastRoundDurationNs == null; // no round has resolved yet

let gen17 = switch (atTableView(reg17, T0, "human")) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
let SUBMIT17 : Int = JOIN17 + 7_000_000_000; // a known, test-controlled gap
ignore ok(reg17.submit(spec, SUBMIT17, "human", gen17, 0, #gather), "human's own round-0 move; this completes the round");
await* cp17.sweep(SUBMIT17); // bot1 is due again for round 1
assert reqLog17.reqs.size() == 2;
let req1_17 = reqLog17.reqs[1];
assert req1_17.turn == 1;
assert req1_17.opponent == "human";
assert req1_17.opponentLastMove == ?#gather; // the human's own round-0 move
assert req1_17.lastRoundDurationNs == ?(SUBMIT17 - JOIN17);
Debug.print("17. MoveRequest carries opponent identity, their last resolved move, and the last round's own duration OK");

// ── 18. ...and it's genuinely the OPPONENT's own identity on each side,
//          never a fixed slot or the seat's own — bot1 and bot2, seated
//          against each other, each see the OTHER's own `sidForCanister`
//          session as `opponent`, never their own ───────────────────────
let reg18 = fresh();
let counter18 = newAfterMutationCounter();
let reqLog18a = newReqLog(); // bot1's own log
let reqLog18b = newReqLog(); // bot2's own log
let cp18 = CanisterPlayers.attach<Rules.State, Rules.Action>(
  spec,
  reg18,
  stubAfterMutation(counter18),
  func(session : TP.SessionId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : (?Rules.Action) -> async* ()) : async* () {
    if (CanisterPlayers.principalOfCanisterSession(session) == bot1) {
      reqLog18a.reqs := Array.concat(reqLog18a.reqs, [req]);
    } else {
      reqLog18b.reqs := Array.concat(reqLog18b.reqs, [req]);
    };
    await* k(?#gather);
  },
  noopArm,
);
let id18 = ok(await* cp18.createTable(bot1, #p1, #open, ""), "bot1 creates a table");
// FakeGame's own #gather never ends the match on its own, so this eager
// join-trigger keeps eagerly settling further rounds — but each seat's
// own `notifyAndApply` in-flight guard (see that func's own doc) blocks
// a NESTED re-ask of a seat whose own outer call hasn't unwound yet, so
// this settles exactly TWO rounds per side before the chain runs out of
// seats it's still allowed to re-ask, not an unbounded loop.
ignore ok(await* cp18.joinTable(bot2, id18, #p2, null), "bot2 joins; game starts — the eager join-trigger settles two rounds for both sides in one call");
assert reqLog18a.reqs.size() == 2;
assert reqLog18b.reqs.size() == 2;
assert reqLog18a.reqs[0].opponent == CanisterPlayers.sidForCanister(bot2, id18); // bot1 sees bot2's own identity...
assert reqLog18b.reqs[0].opponent == CanisterPlayers.sidForCanister(bot1, id18); // ...and bot2 sees bot1's — never its own
Debug.print("18. each seat's own MoveRequest.opponent names the OTHER seat, never itself OK");

// ── 19. registerBot/listBots — a bot appears in the directory under its
//          own principal, and re-registering (e.g. a rename) upserts
//          rather than duplicating ───────────────────────────────────────
let dir19 = CanisterPlayers.newBotDirectory();
CanisterPlayers.registerBot(dir19, bot1, "RacerBot", T0);
assert CanisterPlayers.listBots(dir19).size() == 1;
assert CanisterPlayers.listBots(dir19)[0].name == "RacerBot";
CanisterPlayers.registerBot(dir19, bot1, "RacerBot v2", T0 + 1);
assert CanisterPlayers.listBots(dir19).size() == 1; // still one entry, not two
assert CanisterPlayers.listBots(dir19)[0].name == "RacerBot v2"; // overwritten
Debug.print("19. registerBot upserts by principal, never duplicates OK");

// ── 20. unregisterBot removes; unregistering a never-registered principal
//          is a harmless no-op ────────────────────────────────────────────
CanisterPlayers.registerBot(dir19, bot2, "CheckersBot", T0);
assert CanisterPlayers.listBots(dir19).size() == 2;
CanisterPlayers.unregisterBot(dir19, bot1);
assert CanisterPlayers.listBots(dir19).size() == 1;
assert CanisterPlayers.listBots(dir19)[0].principal == bot2;
CanisterPlayers.unregisterBot(dir19, bot1); // already gone — no trap, no change
assert CanisterPlayers.listBots(dir19).size() == 1;
Debug.print("20. unregisterBot removes by principal; unregistering an absent one is a no-op OK");

// ── 21. rankedBots — highest elo first, alphabetical tiebreak on a tie ───
let bot3 = Principal.fromText("5w2os-7qdam-bqgay-dambq-gay");
let unranked21 : [CanisterPlayers.BotInfo] = [
  { principal = bot1; name = "Zebra"; registeredAt = T0 },
  { principal = bot2; name = "Ant"; registeredAt = T0 },
  { principal = bot3; name = "Middling"; registeredAt = T0 },
];
let scores21 : [(Principal.Principal, Int)] = [(bot1, 1500), (bot2, 1500), (bot3, 1200)];
let scoreOf21 = func(p : Principal.Principal) : ?Int {
  for ((q, s) in scores21.values()) { if (q == p) return ?s };
  null;
};
let ranked21 = CanisterPlayers.rankedBots(unranked21, scoreOf21);
assert ranked21.size() == 3;
// bot1/bot2 tie at 1500 — alphabetical tiebreak puts "Ant" (bot2) first
assert ranked21[0].name == "Ant";
assert ranked21[1].name == "Zebra";
assert ranked21[2].name == "Middling"; // lower score, still ranked (not unrated)
Debug.print("21. rankedBots sorts highest-elo-first with an alphabetical tiebreak OK");

// ── 22. rankedBots — a bot `scoreOf` returns null for (e.g. no leaderboard
//          wired on this host) sorts after every rated bot, regardless of
//          name ─────────────────────────────────────────────────────────
let scoreOf22 = func(p : Principal.Principal) : ?Int = if (p == bot2) ?1000 else null;
let ranked22 = CanisterPlayers.rankedBots(unranked21, scoreOf22);
assert ranked22[0].principal == bot2; // the only rated one
assert ranked22[0].elo == ?1000;
assert ranked22[1].elo == null;
assert ranked22[2].elo == null;
Debug.print("22. rankedBots sorts every unrated bot after every rated one OK");

Debug.print("ALL CANISTER-PLAYERS CHECKS PASSED");
