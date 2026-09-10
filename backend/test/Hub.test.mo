// Unit checks for `Ws.mo`'s `Hub` — the sid<->principal bridge behind
// the real-time push transport. Isolated from the full `IcWebSocketCdk`
// actor machinery (not exercisable in this interpreter harness): these
// drive `Ws.remember`/`Ws.forget` directly against `Hub`'s two maps,
// which is exactly where a real, previously-shipped bug lived —
// "Your opponent walked away" appearing for a game neither player
// actually left, right after ONE of them reloaded the page.
//
// Every one of this package's reference frontends deliberately mints a
// FRESH principal on every page load while the player's own `sid`
// (sessionStorage) survives the reload unchanged (see
// `examples/racing/frontend/src/duel/duel-app.js`'s own doc on why — a
// real `ic-websocket-cdk@0.4.1` bookkeeping quirk). That means the SAME
// `sid` legitimately re-registers under a DIFFERENT principal across a
// reload — exactly the case `remember`/`forget` have to get right: the
// OLD principal's belated `ws_close` (its own `pagehide`-driven goodbye
// has no guarantee of landing before the new page's own `ws_open` does)
// must not be allowed to erase the fresher registration.
// Run: moc -r --package core <core/src> --package ic-websocket-cdk <cdk/src> ... test/Hub.test.mo
import Ws "../src/Ws";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

// Four distinct, valid textual principals — arbitrary identities, not
// tied to any real canister/user.
let PA = Principal.fromText("kcyov-mibae-aqcai-baeaq-cai");
let PB = Principal.fromText("l2hgx-oicai-baeaq-caiba-eaq");
let PC = Principal.fromText("5w2os-7qdam-bqgay-dambq-gay");
let PD = Principal.fromText("ilzwt-kieaq-caiba-eaqca-iba");

func bySid(hub : Ws.Hub, sid : Text) : ?Principal.Principal = Map.get(hub.bySid, Text.compare, sid);
func byPrincipal(hub : Ws.Hub, p : Principal.Principal) : ?Text = Map.get(hub.byPrincipal, Principal.compare, p);

func expectSid(hub : Ws.Hub, sid : Text, want : ?Principal.Principal, msg : Text) {
  let got = bySid(hub, sid);
  let matches = switch (got, want) {
    case (null, null) true;
    case (?g, ?w) Principal.equal(g, w);
    case (_, _) false;
  };
  if (not matches) Runtime.trap(msg # ": bySid[" # sid # "] mismatch");
};
func expectPrincipal(hub : Ws.Hub, p : Principal.Principal, want : ?Text, msg : Text) {
  let got = byPrincipal(hub, p);
  let matches = switch (got, want) {
    case (null, null) true;
    case (?g, ?w) Text.equal(g, w);
    case (_, _) false;
  };
  if (not matches) Runtime.trap(msg # ": byPrincipal mismatch");
};

// ── 1. remember(): a fresh sid registers cleanly in both directions ────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  expectSid(hub, "sid-1", ?PA, "1a");
  expectPrincipal(hub, PA, ?"sid-1", "1b");
  Debug.print("1. remember() on a fresh sid OK");
};

// ── 2. remember(): re-registering the SAME sid under a NEW principal
//      (a page reload) updates bySid AND scrubs the OLD principal's own
//      reverse mapping — the fix's core guarantee. Before the fix,
//      byPrincipal[PA] would still be "sid-1" here.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA); // first connection
  Ws.remember(hub, "sid-1", PB); // reload: same sid, fresh principal
  expectSid(hub, "sid-1", ?PB, "2a: bySid must point at the NEW principal");
  expectPrincipal(hub, PB, ?"sid-1", "2b: byPrincipal must resolve the new principal");
  expectPrincipal(hub, PA, null, "2c: the OLD principal's own reverse mapping must be gone");
  Debug.print("2. remember() on a reconnect scrubs the stale reverse mapping OK");
};

// ── 3. forget(): a belated close for the OLD (already-superseded)
//      principal must NOT erase the fresher registration. This is the
//      exact bug: `onClose` for a stale, abandoned connection silently
//      wiping out `bySid[sid]` — which the session's CURRENT, live
//      connection still needs — and going on to (wrongly) run
//      `disconnectSession` on a player who never actually left.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  Ws.remember(hub, "sid-1", PB); // reconnected under PB before PA's close arrives
  Ws.forget(hub, PA); // PA's belated ws_close/keep-alive-timeout finally lands
  expectSid(hub, "sid-1", ?PB, "3a: a stale principal's forget() must not evict the CURRENT one");
  expectPrincipal(hub, PB, ?"sid-1", "3b: the live registration must still resolve");
  Debug.print("3. forget() on a stale, superseded principal is a no-op on the live mapping OK");
};

// ── 4. forget(): forgetting the CURRENT principal still works normally
//      — the guard in #3 must not turn this into a no-op across the
//      board.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  Ws.forget(hub, PA);
  expectSid(hub, "sid-1", null, "4a: forgetting the live principal must clear bySid");
  expectPrincipal(hub, PA, null, "4b: and byPrincipal");
  Debug.print("4. forget() on the live principal still frees the sid OK");
};

// ── 5. An unrelated sid/principal pair is untouched by any of the
//      above — the fix must stay scoped to the one sid being
//      reconnected/forgotten.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  Ws.remember(hub, "sid-2", PC);
  Ws.remember(hub, "sid-1", PB); // sid-1 reconnects
  Ws.forget(hub, PA); // sid-1's stale principal finally closes
  expectSid(hub, "sid-2", ?PC, "5a: an unrelated sid must be untouched");
  expectPrincipal(hub, PC, ?"sid-2", "5b: and its own reverse mapping");
  Debug.print("5. an unrelated sid/principal pair is unaffected OK");
};

// ── 6. Idempotent remember(): calling it again with the SAME principal
//      (e.g. a redundant re-registration within one connection's life,
//      not a reload) must not scrub its own mapping.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  Ws.remember(hub, "sid-1", PA); // idempotent re-remember, same principal
  expectSid(hub, "sid-1", ?PA, "6a");
  expectPrincipal(hub, PA, ?"sid-1", "6b: must not have scrubbed itself");
  Debug.print("6. remember() is idempotent for an unchanged principal OK");
};

// ── 7. A THIRD reconnect (two reloads in a row) still only ever leaves
//      the latest principal live, with every earlier one's reverse
//      mapping gone.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  Ws.remember(hub, "sid-1", PB);
  Ws.remember(hub, "sid-1", PD);
  expectSid(hub, "sid-1", ?PD, "7a");
  expectPrincipal(hub, PD, ?"sid-1", "7b");
  expectPrincipal(hub, PA, null, "7c: first-generation principal scrubbed");
  expectPrincipal(hub, PB, null, "7d: second-generation principal scrubbed");
  // Even a belated forget() for either OLD generation must still leave
  // the current (PD) registration alone.
  Ws.forget(hub, PA);
  Ws.forget(hub, PB);
  expectSid(hub, "sid-1", ?PD, "7e: still live after both stale forgets");
  Debug.print("7. two reconnects in a row keep only the latest principal live OK");
};

// ── 8. generation(): starts at 0 for an unknown sid, and bumps on EVERY
//      remember() call for a sid — even an idempotent one under the SAME
//      principal (a same-tab reconnect: `SelfGatewayTransport` reuses one
//      fixed principal for its whole lifetime, only the client_key nonce
//      changes on reopen — see `Ws.mo`'s `Hub.generation` doc). This is
//      the extra signal `onClose`'s deferred-close check needs, since
//      `bySid`/`byPrincipal` alone don't change at all across such a
//      reconnect (tests 9/10 below exercise the actual race).
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  if (Ws.generationOf(hub, "sid-1") != 0) Runtime.trap("8a: unknown sid must start at generation 0");
  Ws.remember(hub, "sid-1", PA);
  if (Ws.generationOf(hub, "sid-1") != 1) Runtime.trap("8b: first remember() must bump to 1");
  Ws.remember(hub, "sid-1", PA); // idempotent re-remember, SAME principal
  if (Ws.generationOf(hub, "sid-1") != 2) Runtime.trap("8c: even an idempotent re-remember must bump generation");
  Ws.remember(hub, "sid-1", PB); // a genuine reconnect under a NEW principal
  if (Ws.generationOf(hub, "sid-1") != 3) Runtime.trap("8d: a principal change must also bump generation");
  Debug.print("8. generationOf() bumps on every remember(), idempotent or not OK");
};

// ── 9. The actual race `Ws.mo`'s `onClose`/`finishClose` defer against:
//      old ws_close, new ws_open, new connection's first #req — IN THAT
//      ORDER. `onClose` captures `generationOf(hub, sid)` the moment the
//      stale close is first processed (BEFORE the reconnect's own first
//      #req has landed, since the close arrives first in this ordering);
//      `finishClose` re-checks it after the deferred grace period. This
//      models both halves directly against `Hub`, without a real
//      `IcWebSocketCdk`/`Timer` — a same-tab reconnect keeps the SAME
//      principal (unlike tests 2/3/7's page-reload scenarios), so
//      `forget()`'s own curP==p guard does NOT protect this case on its
//      own — the generation check is what must catch it instead.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA); // the original, still-active connection
  // onClose fires for the OLD (about-to-be-superseded) connection's
  // belated close — captures the generation as of right now, BEFORE the
  // reconnect's own first #req has arrived.
  let seenGen = Ws.generationOf(hub, "sid-1");
  Ws.forget(hub, PA); // the stale ws_close itself — same principal throughout
  // ...then the reconnect's ws_open (Hub learns nothing from ws_open
  // itself — there is no onOpen handler wired) followed by its first
  // #req, which is what actually re-registers it:
  Ws.remember(hub, "sid-1", PA);
  // By the time onClose's deferred check (finishClose) finally runs, the
  // generation has moved — the disconnect must be skipped; the game a
  // still-connected player never left must survive.
  if (Ws.generationOf(hub, "sid-1") == seenGen) {
    Runtime.trap("9: a reconnect's own #req must bump the generation past what onClose saw, or the stale close would wrongly abort a still-live session");
  };
  // And the live registration itself must still be intact.
  expectSid(hub, "sid-1", ?PA, "9b: the reconnected session must still resolve");
  Debug.print("9. old-close/new-open/new-#req race: the generation check catches the stale close OK");
};

// ── 10. The inverse of 9: a GENUINE departure (no reconnect ever
//       follows) must NOT be swallowed by this same mechanism — the
//       generation onClose captured must still match once the deferred
//       check runs, so `finishClose` still proceeds with the disconnect.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  let seenGen = Ws.generationOf(hub, "sid-1");
  Ws.forget(hub, PA); // the close, and this time nobody ever reconnects
  if (Ws.generationOf(hub, "sid-1") != seenGen) {
    Runtime.trap("10: with no reconnect, the generation must still match — a genuine departure must still be detected");
  };
  Debug.print("10. a genuine departure with no reconnect still matches its own generation OK");
};

// ── 11. `finishClose`'s own generation prune, modeled directly: once a
//       genuine departure (test 10's scenario) has run its course — the
//       deferred re-check still matches `seenGen` — the sid's
//       `generation` entry is removed outright, not left to accumulate
//       forever. `generationOf` reading 0 afterward (its "never
//       remembered" default) confirms the entry is actually gone, not
//       just reset in place.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  let seenGen = Ws.generationOf(hub, "sid-1");
  Ws.forget(hub, PA); // the close; nobody reconnects
  // ... `finishClose` would run its disconnect/push work here, then
  // re-check before pruning:
  if (Ws.generationOf(hub, "sid-1") == seenGen) {
    Map.remove(hub.generation, Text.compare, "sid-1");
  };
  if (Ws.generationOf(hub, "sid-1") != 0) {
    Runtime.trap("11: a genuine, un-superseded departure must prune its generation entry back to 0");
  };
  Debug.print("11. finishClose's generation prune removes a genuinely-departed sid's entry OK");
};

// ── 12. The inverse of 11: a reconnect landing AFTER `finishClose`'s
//       initial check passed but BEFORE its own deferred re-check runs
//       (i.e. during the `await`s in between) must stop the prune —
//       removing the entry here would silently reset a STILL-BUMPED
//       counter back to 0, letting some later, already-superseded
//       close wrongly match it again.
// ────────────────────────────────────────────────────────────────────
do {
  let hub = Ws.createHub();
  Ws.remember(hub, "sid-1", PA);
  let seenGen = Ws.generationOf(hub, "sid-1");
  Ws.forget(hub, PA); // the close — initial check (elsewhere) would pass
  // A reconnect lands mid-`finishClose`, in the window opened up by its
  // own `await`s:
  Ws.remember(hub, "sid-1", PA);
  // The re-check right before pruning must now see a mismatch and skip
  // the removal entirely.
  if (Ws.generationOf(hub, "sid-1") == seenGen) {
    Map.remove(hub.generation, Text.compare, "sid-1");
  };
  if (Ws.generationOf(hub, "sid-1") == 0) {
    Runtime.trap("12: a reconnect racing in during finishClose's own awaits must survive the prune, not get reset to 0");
  };
  expectSid(hub, "sid-1", ?PA, "12b: the reconnected session must still resolve");
  Debug.print("12. a reconnect racing finishClose's own prune keeps its bumped generation OK");
};

Debug.print("ALL HUB CHECKS PASSED");
