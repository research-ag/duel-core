// Per-operation checks for `canister_players.mo`. The transport's
// fan-out is stubbed by `mk`: it counts each mutation, then settles the
// table; timers are recorded, never set (the interpreter has none).
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Int "mo:core/Int";
import Option "mo:core/Option";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import CanisterPlayers "../src/canister_players";
import Registry "../src/registry";
import Rules "FakeGame";
import TurnRules "FakeTurnGame";

type Reg = TP.Registry<Rules.State, Rules.Action>;

let spec = Rules.spec();

// The player's first table, and their view of it or `#browsing`.
func idOf(reg : TP.Registry<Rules.State, Rules.Action>, p : Text) : TP.TableId {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) Runtime.trap(p # " is at no table");
  ids[0];
};
func statusOf(reg : TP.Registry<Rules.State, Rules.Action>, at : Int, p : Text) : { #atTable : { id : TP.TableId; view : TP.View<Rules.State> }; #browsing } {
  let ids = reg.tablesOf(p);
  if (ids.size() == 0) return #browsing;
  switch (reg.view(spec, at, p, ids[0])) {
    case (?v) #atTable { id = ids[0]; view = v };
    case null #browsing;
  };
};


let TIMEOUT : Int = 60_000_000_000; // 60 s
let CLAIM_TIMEOUT : Int = 20_000_000_000; // 20 s
// Kept well under CLAIM_TIMEOUT (unlike Lobby.test.mo/Engine.test.mo, this
// suite goes through `canister_players.mo`'s own ops, several of which stamp
// `lastActivity` via their OWN internal `Time.now()` call
let T0 : Int = 1_000_000_000;

func fresh() : Reg {
  let r = Registry.new<Rules.State, Rules.Action>();
  r.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
  r;
};

func ok<T>(r : TP.Res<T>, msg : Text) : T = switch (r) {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};
func expectErr<T>(r : TP.Res<T>, msg : Text) = switch (r) {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err _) ();
};

func atTableView(reg : Reg, at : Int, session : Text) : TP.View<Rules.State> = switch (statusOf(reg, at, session)) {
  case (#atTable v) v.view;
  case (#browsing _) Runtime.trap("expected " # session # " to be at a table");
};

let bot1 = Principal.fromText("aaaaa-aa");
let bot2 = Principal.fromText("2vxsx-fae");
let sidBot1 = CanisterPlayers.idForCanister(bot1, "");
let sidBot2 = CanisterPlayers.idForCanister(bot2, "");

// ── 1. idForCanister / isCanisterSession / principalOfCanisterSession /
//      complexityOfCanisterSession / leaderboardKey ─────────────────────────
assert sidBot1 == "cp:" # bot1.toText() # ":Default"; // "" normalizes to DEFAULT_COMPLEXITY
assert CanisterPlayers.isCanisterSession(sidBot1);
assert not CanisterPlayers.isCanisterSession(bot1.toText());
assert CanisterPlayers.principalOfCanisterSession(sidBot1) == bot1;
// The complexity is the last segment — a different complexity is a
// different player, and it round-trips exactly, even one containing the
// very `:` the other segments split on.
let sidHard = CanisterPlayers.idForCanister(bot1, "Hard");
assert sidHard == "cp:" # bot1.toText() # ":Hard";
assert sidHard != sidBot1;
assert CanisterPlayers.complexityOfCanisterSession(sidBot1) == CanisterPlayers.DEFAULT_COMPLEXITY;
assert CanisterPlayers.complexityOfCanisterSession(sidHard) == "Hard";
assert CanisterPlayers.principalOfCanisterSession(sidHard) == bot1;
assert CanisterPlayers.complexityOfCanisterSession(CanisterPlayers.idForCanister(bot1, "Look-ahead: 3 plies")) == "Look-ahead: 3 plies";
assert CanisterPlayers.principalOfCanisterSession(CanisterPlayers.idForCanister(bot1, "Look-ahead: 3 plies")) == bot1;
// A bot's leaderboard key is its player id: per complexity.
assert CanisterPlayers.leaderboardKey(bot1, "Hard") == sidHard;
assert CanisterPlayers.leaderboardKey(bot1, "") == sidBot1;
Debug.print("1. idForCanister / isCanisterSession / principalOfCanisterSession / complexityOfCanisterSession / leaderboardKey OK");

// ── shared test doubles ────────────────────────────────────────────────────

/// Counts every mutation the stubbed fan-out sees.
func newAfterMutationCounter() : { var calls : Nat } = { var calls = 0 };

/// Records armed wakeups for the tests to inspect.
func newArmLog() : { var calls : [(TP.TableId, Nat)] } = { var calls = [] };

/// A bot context over `reg`: each mutation made here is counted, then
/// settles its table (what the transport's fan-out does); timers are
/// only recorded.
func mk<S, M>(reg : TP.Registry<S, M>, spec : TP.Spec<S, M>, call : CanisterPlayers.CallBot<S, M>, counter : { var calls : Nat }, armLog : { var calls : [(TP.TableId, Nat)] }) : CanisterPlayers.Ctx<S, M> {
  var self : ?CanisterPlayers.Ctx<S, M> = null;
  let ctx : CanisterPlayers.Ctx<S, M> = {
    registry = reg;
    spec;
    store = CanisterPlayers.newStore();
    call;
    afterMutation = func<system>(now : Int, id : TP.TableId, _ : Bool) : async* () {
      counter.calls += 1;
      switch (self) {
        case (?c) await* CanisterPlayers.settle<system, S, M>(c, now, id);
        case null {};
      };
    };
    arm = func<system>(id : TP.TableId, secs : Nat) {
      armLog.calls := armLog.calls.concat([(id, secs)]);
    };
  };
  self := ?ctx;
  ctx;
};

/// A bot that always plays the same fixed action.
func constantBot(move : Rules.Action) : CanisterPlayers.CallBot<Rules.State, Rules.Action> {
  func<system>(_session : TP.PlayerId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    await* k<system>(?move);
  };
};

/// A bot that plays `first` on its first call, `rest` on every call after
func retryingBot(first : Rules.Action, rest : Rules.Action, expectedReason : Text) : CanisterPlayers.CallBot<Rules.State, Rules.Action> {
  var calls = 0;
  func<system>(_session : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    calls += 1;
    if (calls == 1) {
      assert req.retryReason == null;
      await* k<system>(?first);
    } else {
      switch (req.retryReason) {
        case (?reason) assert reason == expectedReason;
        case null Runtime.trap("retry's own MoveRequest must carry the previous rejection reason");
      };
      await* k<system>(?rest);
    };
  };
};

/// A bot that traps/errors every time — `notifyAndApply` treats this
/// identically to `k(null)`, the outcome a host's own `try`/`catch`
/// around the real inter-canister call would produce.
func silentBot() : CanisterPlayers.CallBot<Rules.State, Rules.Action> {
  func<system>(_session : TP.PlayerId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    await* k<system>(null);
  };
};

/// A bot that always plays `move`, recording every `MoveRequest` it was
/// ever handed (in call order) into `log.reqs` — used to inspect the new
/// `opponent`/`opponentLastMove`/`lastRoundDurationNs` fields a smarter
/// bot would key its own memory off (see test 17).
func newReqLog() : { var reqs : [TP.MoveRequest<Rules.State, Rules.Action>] } = {
  var reqs = [];
};
func capturingBot(move : Rules.Action, log : { var reqs : [TP.MoveRequest<Rules.State, Rules.Action>] }) : CanisterPlayers.CallBot<Rules.State, Rules.Action> {
  func<system>(_session : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    log.reqs := log.reqs.concat([req]);
    await* k<system>(?move);
  };
};

// ── 2. createTable / joinTable seat a canister exactly like a human ────────
let reg2 = fresh();
let counter2 = newAfterMutationCounter();
let ctx2 = mk(reg2, spec, constantBot(#gather), counter2, newArmLog());
let cp2 = CanisterPlayers.endpointOf(ctx2);
let id2 = ok(await* cp2.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#stagingYou v) assert v.seat == #p1;
  case (_) Runtime.trap("bot1 should be staging");
};
assert counter2.calls == 1; // afterMutation ran once, for the create
Debug.print("2. createTable seats the canister under its own cp: sid OK");

// ── 3. a human joining a bot's table doesn't move on its own; sweep asks it ───
ignore ok(reg2.joinTable(spec, T0, "human", id2, #p2, null), "human joins bot1's table directly (bypassing canister_players — as transport.mo would)");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // bot1 hasn't been asked yet
  case (_) Runtime.trap("bot1 should be in-game");
};
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx2, T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // sweep asked bot1, which gathered
  case (_) Runtime.trap("bot1 should still be in-game");
};
switch (atTableView(reg2, T0, "human")) {
  case (#inGame v) assert v.oppSubmitted;
  case (_) Runtime.trap("human should see bot1's move landed");
};
Debug.print("3. sweep asks a due, idle canister seat and applies its reply OK");

// ── 4. sweep is idempotent once nobody's due — no double-submit, no trap ───
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx2, T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("4. a second sweep with nobody due is a harmless no-op OK");

// ── 5. round resolution re-triggers: once the human moves too, the round
//      resolves and bot1 is due again for the NEXT round ────────────────────
ignore ok(reg2.submit(spec, T0, "human", idOf(reg2, "human"), (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.gen; case (_) Runtime.trap("n/a") }), (switch (atTableView(reg2, T0, "human")) { case (#inGame v) v.turn; case (_) Runtime.trap("n/a") }), #gather), "human gathers too; round resolves");
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // fresh round — bot1 is due again
  case (_) Runtime.trap("bot1 should still be in-game, next round");
};
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx2, T0);
switch (atTableView(reg2, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("5. a resolved round makes a canister seat due again, caught by the next sweep OK");

// ── 6. an illegal move is retried once, then the legal fallback lands ──────
let reg6 = fresh();
let counter6 = newAfterMutationCounter();
// #attack is illegal at 0 resource (FakeGame's own rule) — the bot's
// first reply is always illegal here; the retry's #gather must be what
// actually lands. retryingBot itself asserts the retry's `retryReason`
// matches this exact text (see its own doc).
let ctx6 = mk(reg6, spec, retryingBot(#attack, #gather, "No resource — GATHER first."), counter6, newArmLog());
let cp6 = CanisterPlayers.endpointOf(ctx6);
let id6 = ok(await* cp6.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg6.joinTable(spec, T0, "human", id6, #p2, null), "human joins");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx6, T0);
switch (atTableView(reg6, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted; // the retried #gather landed
  case (_) Runtime.trap("bot1 should still be in-game after its retried move");
};
Debug.print("6. an illegal move is retried once, carrying validate's own rejection reason, and the legal reply is applied OK");

// ── 7. a bot that never answers leaves the round pending, not stuck ────────
let reg7 = fresh();
let counter7 = newAfterMutationCounter();
let ctx7fail = mk(reg7, spec, silentBot(), counter7, newArmLog());
let cp7fail = CanisterPlayers.endpointOf(ctx7fail);
let id7 = ok(await* cp7fail.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg7.joinTable(spec, T0, "human", id7, #p2, null), "human joins");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx7fail, T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // silence — nothing landed, no trap
  case (_) Runtime.trap("bot1 should still be in-game, still pending");
};
// A fresh `attach` over the SAME registry stands in for "the bot starts
// answering" (this module keeps no state of its own beyond the
// in-flight guard, which a failed attempt always clears — see
// `notifyAndApply`'s own doc) — nudging through it must still work.
let ctx7ok = mk(reg7, spec, constantBot(#gather), counter7, newArmLog());
let _cp7ok = CanisterPlayers.endpointOf(ctx7ok);
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx7ok, T0);
switch (atTableView(reg7, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game after finally answering");
};
Debug.print("7. a silent/trapping bot leaves the round pending, not stuck forever OK");

// ── 8. bot-vs-bot: the SECOND bot's own joinTable eagerly triggers BOTH
//      seats immediately ────────────────────────────────────────────────────
let reg8 = fresh();
let counter8 = newAfterMutationCounter();
let ctx8 = mk(reg8, spec, constantBot(#gather), counter8, newArmLog());
let cp8 = CanisterPlayers.endpointOf(ctx8);
let id8 = ok(await* cp8.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(await* cp8.joinTable<system>(bot2, id8, #p2, null, ""), "bot2 joins; game starts");
switch (atTableView(reg8, T0, sidBot1)) {
  case (#inGame v) assert v.turn > 0; // both seats already moved and resolved a round
  case (_) Runtime.trap("bot1 should be in-game, at least one round in");
};
Debug.print("8. two canister seats joining each other eagerly resolve rounds with no human, no sweep OK");

// ── 9. leave / ackEnded forward correctly, deriving the session from the
//      caller's own principal AND the tableId it names ──────────────────────
let reg9 = fresh();
let counter9 = newAfterMutationCounter();
let ctx9 = mk(reg9, spec, constantBot(#gather), counter9, newArmLog());
let cp9 = CanisterPlayers.endpointOf(ctx9);
let id9 = ok(await* cp9.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg9.joinTable(spec, T0, "human", id9, #p2, null), "human joins; game live");
let genBefore = switch (atTableView(reg9, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
ok(await* cp9.leave<system>(bot1, id9, genBefore), "bot1 leaves the live game — a shared #aborted debrief");
switch (atTableView(reg9, T0, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("bot1's own leave should abort as p1");
  };
  case (_) Runtime.trap("bot1 should be in the shared debrief it just created");
};
await* cp9.ackEnded<system>(bot1, id9); // no #endedByOther notice here: a no-op
assert reg9.tablesOf(sidBot1) == [id9]; // still holds its side of the debrief
ok(await* cp9.leave<system>(bot1, id9, genBefore), "bot1 acks its own debrief with a second leave");
switch (statusOf(reg9, T0, sidBot1)) {
  case (#browsing _) {};
  case (_) Runtime.trap("bot1 should be at no table after acking its debrief");
};
expectErr(await* cp9.leave<system>(bot1, id9, 0), "bot1 (not seated anywhere any more) tries to leave the same table again");
Debug.print("9. leave / ackEnded forward correctly, deriving the session from the caller's own principal and tableId OK");

// ── 10. Flow 2, eager dual-seat assignment (registry.createTableReserving,
//      see ../../CLAUDE.md's "Canister players" note): a canister seated this
//      way is ALREADY due the instant the table exists ──────────────────────
let reg10 = fresh();
let counter10 = newAfterMutationCounter();
let ctx10 = mk(reg10, spec, constantBot(#gather), counter10, newArmLog());
let _cp10 = CanisterPlayers.endpointOf(ctx10);
ignore ok(reg10.createTableReserving(spec, T0, "human", #p1, #open, sidBot1, ""), "human creates a table, atomically reserving bot1 for #p2");
switch (atTableView(reg10, T0, sidBot1)) {
  case (#inGame v) assert not v.youSubmitted; // due immediately — bot1 never called joinTable
  case (_) Runtime.trap("bot1 should already be #inGame, eagerly seated");
};
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx10, T0);
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
//      the caller names ─────────────────────────────────────────────────────
let reg11 = fresh();
let counter11 = newAfterMutationCounter();
let ctx11 = mk(reg11, spec, constantBot(#gather), counter11, newArmLog());
let cp11 = CanisterPlayers.endpointOf(ctx11);
expectErr(await* cp11.claimWin<system>(bot1, 1, 0), "bot1 (not seated anywhere) tries to claim a win");
expectErr(await* cp11.reset<system>(bot1, 1, 0), "bot1 (not seated anywhere) tries to reset");
let id11 = ok(await* cp11.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg11.joinTable(spec, T0, "human", id11, #p2, null), "human joins; game live");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx11, T0); // bot1 gathers; now waiting on human
let g11 = switch (atTableView(reg11, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
switch (await* cp11.claimWin<system>(bot1, id11, g11)) {
  case (#err(#notOverdue _)) {};
  case (other) Runtime.trap("bot1's own claim window hasn't elapsed yet, got " # debug_show (other));
};
ok(await* cp11.reset<system>(bot1, id11, g11), "bot1 resets its own live game — a shared #aborted debrief, same as leave");
switch (atTableView(reg11, T0, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("bot1's own reset (while seated) should abort as leave does");
  };
  case (_) Runtime.trap("bot1 should be in the shared debrief its own reset just created");
};
Debug.print("11. claimWin / reset forward correctly and route per-table OK");

// ── 12. unattended, canister-vs-canister: bot2 never answers at all ────────
// One shared `callBot`, dispatching per-SESSION rather than per-`attach`
// (unlike test 7's "a fresh attach stands in for a bot that starts answering"
// trick)
func perSessionBot(silent : TP.PlayerId) : CanisterPlayers.CallBot<Rules.State, Rules.Action> {
  func<system>(session : TP.PlayerId, _req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    if (session == silent) { await* k<system>(null) } else { await* k<system>(?#gather) };
  };
};
let reg12 = fresh();
let counter12 = newAfterMutationCounter();
let ctx12 = mk(reg12, spec, perSessionBot(sidBot2), counter12, newArmLog());
let cp12 = CanisterPlayers.endpointOf(ctx12);
let id12 = ok(await* cp12.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(await* cp12.joinTable<system>(bot2, id12, #p2, null, ""), "bot2 joins; game starts — bot1's own eager join-trigger gathers, bot2 stays silent");
switch (atTableView(reg12, T0, sidBot1), atTableView(reg12, T0, sidBot2)) {
  case (#inGame v1, #inGame v2) {
    assert v1.youSubmitted;
    assert not v2.youSubmitted;
  };
  case (_, _) Runtime.trap("bot1 should be waiting, bot2 should still be due");
};
let PAST_CLAIM : Int = T0 + CLAIM_TIMEOUT + 1_000_000_000; // safely past bot1's own claim window
// One sweep: bot2 is asked again (still silent), bot1's stall is now
// claimable, and the claim's own fan-out settles the fresh debrief —
// nobody's around to decide on a rematch in an all-canister match, so
// both seats are acked right away, with no deadlock waiting on each
// other (see `maybeAckDebrief`'s own doc).
let before12 = counter12.calls;
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx12, PAST_CLAIM);
assert counter12.calls == before12 + 3; // the claim, then each seat's ack
assert reg12.tablesOf(sidBot1).size() == 0;
assert reg12.tablesOf(sidBot2).size() == 0;
assert reg12.tables.get(id12).isNull(); // both acked, nothing owed: GC'd
Debug.print("12. an unattended canister-vs-canister match finishes via sweep's own automatic claim-win, no human involved OK");

// ── 13. the reported bug this fix addresses: a game ending via a HUMAN's own
//      action (never routed through canister_players.mo at all) leaves a
//      canister seat pinned to the just-ended table ─────────────────────────
let reg13 = fresh();
let counter13 = newAfterMutationCounter();
let ctx13 = mk(reg13, spec, constantBot(#gather), counter13, newArmLog());
let cp13 = CanisterPlayers.endpointOf(ctx13);
let id13 = ok(await* cp13.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg13.joinTable(spec, T0, "human", id13, #p2, null), "human joins; game live");
let genAbort13 = switch (atTableView(reg13, T0, sidBot1)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
// The human forfeits/leaves outright
ok(reg13.leave(T0, "human", idOf(reg13, "human"), genAbort13), "human forfeits — bot1's side of the debrief is never told");
switch (statusOf(reg13, T0, sidBot1)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot1 should be pinned to its own unacked debrief, same as the reported bug, got " # debug_show (other));
};
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx13, T0);
// Still pinned — the human hasn't acked THEIR side yet, so they might
// still rematch; freeing bot1 now would silently break that option.
switch (statusOf(reg13, T0, sidBot1)) {
  case (#atTable { view = #debrief _ }) {};
  case (other) Runtime.trap("bot1 should stay pinned while its human partner could still rematch, got " # debug_show (other));
};
ok(reg13.leave(T0, "human", idOf(reg13, "human"), genAbort13), "human acks their own debrief too (idempotent gen, same as leave's own doc) — no rematch coming");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx13, T0);
// Freed — nothing's left for bot1 to wait on, no idle-timeout wait needed.
switch (statusOf(reg13, T0, sidBot1)) {
  case (#browsing _) {};
  case (other) Runtime.trap("bot1 should be free the moment its human partner is gone for good, got " # debug_show (other));
};
Debug.print("13. a canister seat's own finished debrief only auto-acks once its human partner is gone for good OK");

// ── 14. settle asks a due seat for one table, without scanning the registry ───
let reg14 = fresh();
let counter14 = newAfterMutationCounter();
let ctx14 = mk(reg14, spec, constantBot(#gather), counter14, newArmLog());
let cp14 = CanisterPlayers.endpointOf(ctx14);
let id14 = ok(await* cp14.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg14.joinTable(spec, T0, "human", id14, #p2, null), "human joins bot1's table directly, as transport.mo's own onSettled hook would observe");
await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx14, T0, id14);
switch (atTableView(reg14, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should still be in-game");
};
Debug.print("14. settle asks a due canister seat for one specific table OK");

// ── 15. a waiting-but-not-overdue seat arms exactly one precisely-timed
//      claim-win wakeup ─────────────────────────────────────────────────────
let reg15 = fresh();
let counter15 = newAfterMutationCounter();
let armLog15 = newArmLog();
let ctx15 = mk(reg15, spec, constantBot(#gather), counter15, armLog15);
let cp15 = CanisterPlayers.endpointOf(ctx15);
let id15 = ok(await* cp15.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg15.joinTable(spec, T0, "human", id15, #p2, null), "human joins; game live, nobody due-asked yet");
assert armLog15.calls == [];
await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx15, T0, id15);
switch (atTableView(reg15, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted and not v.claimWinAvailable;
  case (_) Runtime.trap("bot1 should be waiting, not yet claimable");
};
assert armLog15.calls == [(id15, CLAIM_TIMEOUT.toNat() / 1_000_000_000)];
await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx15, T0, id15); // re-settling before the wakeup fires must not claim early
switch (atTableView(reg15, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted and not v.claimWinAvailable;
  case (_) Runtime.trap("bot1 should still be waiting, still not claimable");
};
let PAST_CLAIM15 : Int = T0 + CLAIM_TIMEOUT + 1_000_000_000;
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx15, PAST_CLAIM15); // stands in for the armed Timer firing
switch (atTableView(reg15, PAST_CLAIM15, sidBot1)) {
  case (#debrief d) switch (d.end) {
    case (#claimed(#p1)) {};
    case (_) Runtime.trap("bot1's own armed claim-check should credit p1");
  };
  case (other) Runtime.trap("expected a #claimed debrief, got " # debug_show (other));
};
Debug.print("15. a waiting-but-not-yet-overdue canister seat arms exactly one precisely-timed claim-win check OK");

// ── 16. the same bot1 player sits at TWO tables at once, each settled and
//      left independently ────────────────────────────────────────────────────
let reg16 = fresh();
let counter16 = newAfterMutationCounter();
let ctx16 = mk(reg16, spec, constantBot(#gather), counter16, newArmLog());
let cp16 = CanisterPlayers.endpointOf(ctx16);
let idA16 = ok(await* cp16.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates board A");
let idB16 = ok(await* cp16.createTable<system>(bot1, #p1, #open, "", ""), "the SAME bot1 creates board B too");
assert idA16 != idB16;
assert reg16.tablesOf(sidBot1) == [idA16, idB16];
func view16(id : TP.TableId) : TP.View<Rules.State> = switch (reg16.view(spec, T0, sidBot1, id)) {
  case (?v) v;
  case null Runtime.trap("no such table");
};
ignore ok(reg16.joinTable(spec, T0, "humanA", idA16, #p2, null), "humanA joins board A");
ignore ok(reg16.joinTable(spec, T0, "humanB", idB16, #p2, null), "humanB joins board B");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx16, T0); // one pass settles bot1's due move on BOTH boards
switch (view16(idA16), view16(idB16)) {
  case (#inGame vA, #inGame vB) {
    assert vA.youSubmitted;
    assert vB.youSubmitted;
  };
  case (_, _) Runtime.trap("bot1 should be waiting on both boards after one sweep");
};
let genA16 = switch (view16(idA16)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("n/a");
};
ok(await* cp16.leave<system>(bot1, idA16, genA16), "bot1 leaves board A only");
switch (view16(idA16)) {
  case (#debrief d) switch (d.end) {
    case (#aborted(#p1)) {};
    case (_) Runtime.trap("board A's own leave should abort as p1");
  };
  case (_) Runtime.trap("board A should be in the debrief bot1's own leave just created");
};
switch (view16(idB16)) {
  case (#inGame v) assert v.youSubmitted; // untouched — board A's leave had no effect here
  case (_) Runtime.trap("board B should still be live — bot1's board-A leave must not have touched it");
};
Debug.print("16. the same bot1 player sits at two tables at once, settled and left independently OK");

// ── 17. MoveRequest carries the opponent's own identity, their most recently
//      RESOLVED move, and how long the last round took ──────────────────────
let reg17 = fresh();
let counter17 = newAfterMutationCounter();
let reqLog17 = newReqLog();
let ctx17 = mk(reg17, spec, capturingBot(#gather, reqLog17), counter17, newArmLog());
let cp17 = CanisterPlayers.endpointOf(ctx17);
let id17 = ok(await* cp17.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");

let JOIN17 : Int = 5_000_000_000;
ignore ok(reg17.joinTable(spec, JOIN17, "human", id17, #p2, null), "human joins at a known time — starts round 0");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx17, T0); // bot1 is due for round 0
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
ignore ok(reg17.submit(spec, SUBMIT17, "human", idOf(reg17, "human"), gen17, 0, #gather), "human's own round-0 move; this completes the round");
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx17, SUBMIT17); // bot1 is due again for round 1
assert reqLog17.reqs.size() == 2;
let req1_17 = reqLog17.reqs[1];
assert req1_17.turn == 1;
assert req1_17.opponent == "human";
assert req1_17.opponentLastMove == ?#gather; // the human's own round-0 move
assert req1_17.lastRoundDurationNs == ?(SUBMIT17 - JOIN17);
Debug.print("17. MoveRequest carries opponent identity, their last resolved move, and the last round's own duration OK");

// ── 18. ...and it's genuinely the OPPONENT's own identity on each side,
//      never a fixed slot or the seat's own ─────────────────────────────────
let reg18 = fresh();
let counter18 = newAfterMutationCounter();
let reqLog18a = newReqLog(); // bot1's own log
let reqLog18b = newReqLog(); // bot2's own log
let ctx18 = mk(
  reg18,
  spec,
  func<system>(session : TP.PlayerId, req : TP.MoveRequest<Rules.State, Rules.Action>, k : <system>(?Rules.Action) -> async* ()) : async* () {
    if (CanisterPlayers.principalOfCanisterSession(session) == bot1) {
      reqLog18a.reqs := reqLog18a.reqs.concat([req]);
    } else {
      reqLog18b.reqs := reqLog18b.reqs.concat([req]);
    };
    await* k<system>(?#gather);
  },
  counter18,
  newArmLog(),
);
let cp18 = CanisterPlayers.endpointOf(ctx18);
let id18 = ok(await* cp18.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
// The join asks both seats for round 0; round 1, due inside bot2's own
// reply, is left to a wakeup (test 28)
ignore ok(await* cp18.joinTable<system>(bot2, id18, #p2, null, ""), "bot2 joins; game starts — the join settles round 0 for both sides");
assert reqLog18a.reqs.size() == 1;
assert reqLog18b.reqs.size() == 1;
assert reqLog18a.reqs[0].opponent == CanisterPlayers.idForCanister(bot2, ""); // bot1 sees bot2's own identity...
assert reqLog18b.reqs[0].opponent == CanisterPlayers.idForCanister(bot1, ""); // ...and bot2 sees bot1's — never its own
Debug.print("18. each seat's own MoveRequest.opponent names the OTHER seat, never itself OK");

// ── 19. registerBot/listBots — a bot appears in the directory under its own
//      principal, and re-registering (e.g. a rename) upserts rather than
//      duplicating ──────────────────────────────────────────────────────────
let dir19 = CanisterPlayers.newBotDirectory();
CanisterPlayers.registerBot(dir19, bot1, "RacerBot", [], T0);
assert CanisterPlayers.listBots(dir19).size() == 1;
assert CanisterPlayers.listBots(dir19)[0].name == "RacerBot";
assert CanisterPlayers.listBots(dir19)[0].complexities == ["Default"]; // declared none — listed under DEFAULT_COMPLEXITY
CanisterPlayers.registerBot(dir19, bot1, "RacerBot v2", ["Easy", "Hard"], T0 + 1);
assert CanisterPlayers.listBots(dir19).size() == 1; // still one entry, not two
assert CanisterPlayers.listBots(dir19)[0].name == "RacerBot v2"; // overwritten
assert CanisterPlayers.listBots(dir19)[0].complexities == ["Easy", "Hard"]; // ...list included
Debug.print("19. registerBot upserts by principal, never duplicates OK");

// ── 20. unregisterBot removes; unregistering a never-registered principal is
//      a harmless no-op ─────────────────────────────────────────────────────
CanisterPlayers.registerBot(dir19, bot2, "CheckersBot", [], T0);
assert CanisterPlayers.listBots(dir19).size() == 2;
CanisterPlayers.unregisterBot(dir19, bot1);
assert CanisterPlayers.listBots(dir19).size() == 1;
assert CanisterPlayers.listBots(dir19)[0].principal == bot2;
CanisterPlayers.unregisterBot(dir19, bot1); // already gone — no trap, no change
assert CanisterPlayers.listBots(dir19).size() == 1;
Debug.print("20. unregisterBot removes by principal; unregistering an absent one is a no-op OK");

// ── 21. rankedBots — highest elo first, alphabetical tiebreak on a tie ─────
let bot3 = Principal.fromText("5w2os-7qdam-bqgay-dambq-gay");
let unranked21 : [CanisterPlayers.BotInfo] = [
  {
    principal = bot1;
    name = "Zebra";
    complexities = ["Default"];
    registeredAt = T0;
  },
  {
    principal = bot2;
    name = "Ant";
    complexities = ["Default"];
    registeredAt = T0;
  },
  {
    principal = bot3;
    name = "Middling";
    complexities = ["Default"];
    registeredAt = T0;
  },
];
let scores21 : [(Principal.Principal, Int)] = [(bot1, 1500), (bot2, 1500), (bot3, 1200)];
let scoreOf21 = func(p : Principal.Principal, _complexity : Text) : ?Int {
  for ((q, s) in scores21.values()) { if (q == p) return ?s };
  null;
};
let ranked21 = CanisterPlayers.rankedBots(unranked21, scoreOf21);
assert ranked21.size() == 3;
// bot1/bot2 tie at 1500 — alphabetical tiebreak puts "Ant" (bot2) first
assert ranked21[0].name == "Ant";
assert ranked21[1].name == "Zebra";
assert ranked21[2].name == "Middling"; // lower score, still ranked (not unrated)
assert ranked21[0].complexities == [{ complexity = "Default"; elo = ?1500 }];
Debug.print("21. rankedBots sorts highest-elo-first with an alphabetical tiebreak OK");

// ── 22. rankedBots — a bot `scoreOf` returns null for (e.g. no leaderboard
//      wired on this host) sorts after every rated bot, regardless of name ───
let scoreOf22 = func(p : Principal.Principal, _complexity : Text) : ?Int = if (p == bot2) ?1000 else null;
let ranked22 = CanisterPlayers.rankedBots(unranked21, scoreOf22);
assert ranked22[0].principal == bot2; // the only rated one
assert ranked22[0].complexities[0].elo == ?1000;
assert ranked22[1].complexities[0].elo == null;
assert ranked22[2].complexities[0].elo == null;
Debug.print("22. rankedBots sorts every unrated bot after every rated one OK");

// ── 23. registerBot normalizes the complexity list ─────────────────────────
let dir23 = CanisterPlayers.newBotDirectory();
CanisterPlayers.registerBot(dir23, bot1, "Ladder", ["Lion", "Rabbit", "Fox", "", "Rabbit"], T0);
assert CanisterPlayers.listBots(dir23)[0].complexities == ["Lion", "Rabbit", "Fox", "Default"]; // not sorted — a ladder's own order is meaningful
Debug.print("23. registerBot keeps declared order, normalizes empty to Default, drops duplicates OK");

// ── 24. rankedBots scores each complexity separately, ranks a bot by its
//      best one, and keeps a bot's own complexities in declared order ───────
let unranked24 : [CanisterPlayers.BotInfo] = [
  {
    principal = bot1;
    name = "Ladder";
    complexities = ["Easy", "Hard"];
    registeredAt = T0;
  },
  {
    principal = bot2;
    name = "Single";
    complexities = ["Default"];
    registeredAt = T0;
  },
];
let scoreOf24 = func(p : Principal.Principal, complexity : Text) : ?Int {
  if (p == bot1 and complexity == "Easy") ?1100 else if (p == bot1 and complexity == "Hard") ?1500 else if (p == bot2) ?1400 else null;
};
let ranked24 = CanisterPlayers.rankedBots(unranked24, scoreOf24);
assert ranked24[0].name == "Ladder"; // best complexity (Hard, 1500) beats Single's 1400, even though Easy alone wouldn't
assert ranked24[0].complexities == [{ complexity = "Easy"; elo = ?1100 }, { complexity = "Hard"; elo = ?1500 }]; // declared order, not rating order
assert ranked24[1].complexities == [{ complexity = "Default"; elo = ?1400 }];
Debug.print("24. rankedBots rates every complexity separately and ranks a bot by its best OK");

// ── 25. a seat's complexity reaches the bot on every ask as
//      MoveRequest.complexity ───────────────────────────────────────────────
let reg25 = fresh();
let counter25 = newAfterMutationCounter();
let reqLog25 = newReqLog();
let ctx25 = mk(reg25, spec, capturingBot(#gather, reqLog25), counter25, newArmLog());
let cp25 = CanisterPlayers.endpointOf(ctx25);
let id25 = ok(await* cp25.createTable<system>(bot1, #p1, #open, "", "Hard"), "bot1 creates a table, playing Hard");
ignore ok(await* cp25.joinTable<system>(bot2, id25, #p2, null, ""), "bot2 joins at its default complexity; game starts");
assert reqLog25.reqs.size() >= 2;
let sidHard25 = CanisterPlayers.idForCanister(bot1, "Hard");
for (req in reqLog25.reqs.values()) {
  switch (req.seat) {
    case (#p1) {
      assert req.complexity == "Hard";
      assert req.opponent == CanisterPlayers.idForCanister(bot2, ""); // the opponent's own session carries ITS complexity
    };
    case (#p2) {
      assert req.complexity == CanisterPlayers.DEFAULT_COMPLEXITY;
      assert req.opponent == sidHard25;
    };
  };
};
await* CanisterPlayers.sweep<system, Rules.State, Rules.Action>(ctx25, T0);
let g25 = switch (atTableView(reg25, T0, sidHard25)) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("bot1 should be in-game under its Hard session");
};
expectErr(await* cp25.claimWin<system>(bot1, id25, g25), "bot1 claims a win with nothing overdue"); // #notOverdue/#wrongPhase — but found its Hard seat, not #notSeated
expectErr(await* cp25.claimWin<system>(bot1, id25 + 1, g25), "bot1 claims on a board it never sat at"); // #notSeated
ok(await* cp25.leave<system>(bot1, id25, g25), "bot1 leaves via principal + tableId alone — its Hard seat is looked up on the board");
// The abort's own fan-out settles the debrief: two canister seats ack it
// at once.
assert reg25.tablesOf(sidHard25).size() == 0;
assert reg25.tablesOf(CanisterPlayers.idForCanister(bot2, "")).size() == 0;
Debug.print("25. MoveRequest.complexity carries each seat's own pick; leave/claimWin resolve a complexity-seated session from principal + tableId OK");

// ── 26. a human's Rematch against a bot: the rematch staging reserves the
//      open seat for the bot's OWN session, and the bot's ordinary joinTable
//      at the SAME complexity (what a frontend re-issues on that staging ────
let reg26 = fresh();
let counter26 = newAfterMutationCounter();
let ctx26 = mk(reg26, spec, constantBot(#gather), counter26, newArmLog());
let cp26 = CanisterPlayers.endpointOf(ctx26);
let id26 = ok(reg26.createTable(spec, T0, "human", #p1, #open, ""), "human creates a table");
ignore ok(await* cp26.joinTable<system>(bot1, id26, #p2, null, "Hard"), "bot1 joins at Hard; game starts");
let sidHard26 = CanisterPlayers.idForCanister(bot1, "Hard");
let genFirst26 = switch (atTableView(reg26, T0, "human")) {
  case (#inGame v) v.gen;
  case (_) Runtime.trap("human should be in-game");
};
ok(reg26.leave(T0, "human", idOf(reg26, "human"), genFirst26), "human forfeits — shared #aborted debrief");
await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx26, T0, id26);
switch (atTableView(reg26, T0, sidHard26)) {
  case (#debrief _) {};
  case (other) Runtime.trap("bot1 should still hold its side of the debrief while the human decides, got " # debug_show (other));
};
ignore ok(reg26.rematch(spec, T0, "human", idOf(reg26, "human")), "human clicks Rematch");
switch (atTableView(reg26, T0, "human")) {
  case (#stagingYou v) assert v.reservedForPartner;
  case (other) Runtime.trap("human's rematch should stage the same table reserved for the bot, got " # debug_show (other));
};
expectErr(await* cp26.joinTable<system>(bot1, id26, #p2, null, "Easy"), "bot1 re-joining at a DIFFERENT complexity is a different session — reserved seat refused");
switch (ok(await* cp26.joinTable<system>(bot1, id26, #p2, null, "Hard"), "bot1 re-joins at the same complexity — matches the reservation")) {
  case (#started _) {};
  case (other) Runtime.trap("the rematch should start outright, got " # debug_show (other));
};
switch (atTableView(reg26, T0, "human")) {
  case (#inGame v) assert v.gen != genFirst26 and v.oppSubmitted; // a fresh match, and the bot's eager join-trigger already asked it
  case (other) Runtime.trap("human should be in the rematch, got " # debug_show (other));
};
Debug.print("26. a bot re-joining a human's rematch staging at the same complexity matches the reservation and starts the game OK");

// ── 27. the bot's own move settles its table once, through the fan-out:
//      one claim check armed, not two ────────────────────────────────────────
let reg27 = fresh();
let armLog27 = newArmLog();
let ctx27 = mk(reg27, spec, constantBot(#gather), newAfterMutationCounter(), armLog27);
let cp27 = CanisterPlayers.endpointOf(ctx27);
let id27 = ok(await* cp27.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(reg27.joinTable(spec, T0, "human", id27, #p2, null), "human joins; game live");
await* CanisterPlayers.settle<system, Rules.State, Rules.Action>(ctx27, T0, id27);
switch (atTableView(reg27, T0, sidBot1)) {
  case (#inGame v) assert v.youSubmitted;
  case (_) Runtime.trap("bot1 should have moved and be waiting");
};
assert armLog27.calls == [(id27, CLAIM_TIMEOUT.toNat() / 1_000_000_000)];
Debug.print("27. a bot's move settles once through the fan-out: one claim check armed, not two OK");

// ── 28. bot-vs-bot never chains inside one call: a canister seat due
//      inside the other's reply is asked from a fresh wakeup (a zero-second
//      timer), one bot call per message, to the real ending ────────────────
let turnSpec = TurnRules.spec();
let reg28 = Registry.new<TurnRules.State, TurnRules.Action>();
reg28.setTimeouts(TIMEOUT, CLAIM_TIMEOUT);
let armLog28 = newArmLog();
var asked28 = 0;
let ctx28 = mk(
  reg28,
  turnSpec,
  func<system>(_session : TP.PlayerId, req : TP.MoveRequest<TurnRules.State, TurnRules.Action>, k : <system>(?TurnRules.Action) -> async* ()) : async* () {
    asked28 += 1;
    await* k<system>(?(if (req.game.count >= 6) #winNow else #inc));
  },
  newAfterMutationCounter(),
  armLog28,
);
let cp28 = CanisterPlayers.endpointOf(ctx28);
let id28 = ok(await* cp28.createTable<system>(bot1, #p1, #open, "", ""), "bot1 creates a table");
ignore ok(await* cp28.joinTable<system>(bot2, id28, #p2, null, ""), "bot2 joins; game starts");
assert asked28 == 1; // bot1 only; bot2's turn is left to a wakeup
var wakeups28 = 0;
label play loop {
  let immediate = armLog28.calls.filter(func((_, secs) : (TP.TableId, Nat)) : Bool = secs == 0);
  if (immediate.size() == 0) break play;
  armLog28.calls := [];
  let before = asked28;
  await* CanisterPlayers.settle<system, TurnRules.State, TurnRules.Action>(ctx28, T0, id28); // stands in for the zero-second Timer
  assert asked28 == before + 1;
  wakeups28 += 1;
  assert wakeups28 < 20;
};
assert asked28 == 7; // six INCs, then bot1's WINNOW: played out, not claimed
assert reg28.tablesOf(sidBot1).size() == 0 and reg28.tablesOf(sidBot2).size() == 0; // finished, both debriefs acked
Debug.print("28. bot-vs-bot takes one bot call per message, through zero-second wakeups, to the real ending OK");

Debug.print("ALL CANISTER-PLAYERS CHECKS PASSED");
