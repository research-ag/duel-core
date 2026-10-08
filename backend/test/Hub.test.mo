// Unit checks for `transport.mo`'s `Hub` and its other pure helpers.
import Transport "../src/transport";
import TP "../src/lib";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let PA = Principal.fromText("kcyov-mibae-aqcai-baeaq-cai");
let PB = Principal.fromText("l2hgx-oicai-baeaq-caiba-eaq");

let T0 : Int = 1_000_000_000_000;
let SEC : Int = 1_000_000_000;
let TTL : Int = Transport.PRESENCE_TTL_NS;

func check(cond : Bool, msg : Text) {
  if (not cond) Runtime.trap(msg);
};

// ── 1. seen(): first contact creates a link with a non-zero rev ────────────
do {
  let hub = Transport.createHub();
  check(Transport.revOf(hub, "sid-1") == 0, "1a: an unknown sid has rev 0");
  check(not Transport.isPresent(hub, "sid-1", T0), "1b: and is not present");
  ignore Transport.seen(hub, "sid-1", T0);
  check(Transport.revOf(hub, "sid-1") != 0, "1c: a link starts at a fresh rev");
  check(Transport.isPresent(hub, "sid-1", T0), "1d: and is present");
  Debug.print("1. seen() creates a link OK");
};

// ── 2. seen() again refreshes lastSeen but leaves rev alone ────────────────
do {
  let hub = Transport.createHub();
  ignore Transport.seen(hub, "sid-1", T0);
  let rev = Transport.revOf(hub, "sid-1");
  let l = Transport.seen(hub, "sid-1", T0 + SEC);
  check(l.rev == rev, "2a: a request alone is not a status change");
  check(l.lastSeen == T0 + SEC, "2b");
  Debug.print("2. seen() on a known sid keeps its rev OK");
};

// ── 3. touch(): bumps a linked sid, ignores an unlinked one; revisions are
//      hub-wide and strictly increasing ─────────────────────────────────────
do {
  let hub = Transport.createHub();
  ignore Transport.seen(hub, "sid-1", T0);
  ignore Transport.seen(hub, "sid-2", T0);
  let r1 = Transport.revOf(hub, "sid-1");
  let r2 = Transport.revOf(hub, "sid-2");
  check(r2 > r1, "3a: a later link gets a higher rev");
  Transport.touch(hub, "sid-1");
  check(Transport.revOf(hub, "sid-1") > r2, "3b: touch moves past every rev handed out so far");
  check(Transport.revOf(hub, "sid-2") == r2, "3c: an untouched sid keeps its rev");
  Transport.touch(hub, "cp:nobody");
  check(Transport.revOf(hub, "cp:nobody") == 0, "3d: touch never creates a link");
  Debug.print("3. touch() bumps only linked sessions, monotonically OK");
};

// ── 4. presence lapses after PRESENCE_TTL_NS without a request ─────────────
do {
  let hub = Transport.createHub();
  ignore Transport.seen(hub, "sid-1", T0);
  check(Transport.isPresent(hub, "sid-1", T0 + TTL - 1), "4a: still present just inside the TTL");
  check(not Transport.isPresent(hub, "sid-1", T0 + TTL), "4b: absent at the TTL");
  ignore Transport.seen(hub, "sid-1", T0 + TTL);
  check(Transport.isPresent(hub, "sid-1", T0 + TTL + SEC), "4c: a request restores presence");
  Debug.print("4. presence follows the last request OK");
};

// ── 5. prune(): drops exactly the links that stopped being present ─────────
do {
  let hub = Transport.createHub();
  ignore Transport.seen(hub, "old", T0);
  ignore Transport.seen(hub, "new", T0 + 100 * SEC);
  Transport.prune(hub, T0 + TTL);
  check(Transport.revOf(hub, "old") == 0, "5a: the lapsed link is gone");
  check(Transport.revOf(hub, "new") != 0, "5b: the live one stays");
  Debug.print("5. prune() drops lapsed links only OK");
};

// ── 13. sidForPrincipal(): a pure, deterministic mapping ───────────────────
do {
  let sidA = Transport.sidForPrincipal(PA);
  if (sidA != Transport.sidForPrincipal(PA)) {
    Runtime.trap("13a: sidForPrincipal must be deterministic for the same principal");
  };
  if (not sidA.startsWith(#text(Transport.PRINCIPAL_SID_PREFIX))) {
    Runtime.trap("13b: sidForPrincipal's own output must fall in its reserved namespace");
  };
  if (sidA == Transport.sidForPrincipal(PB)) {
    Runtime.trap("13c: distinct principals must not collide");
  };
  Debug.print("13. sidForPrincipal() is a pure, collision-free, namespaced mapping OK");
};

// ── 14. isAuthorizedSid(): the reserved namespace is enforced ──────────────
do {
  let sid = Transport.sidForPrincipal(PA);
  if (not Transport.isAuthorizedSid(sid, PA)) {
    Runtime.trap("14a: the owning principal must be authorized for its own sid");
  };
  if (Transport.isAuthorizedSid(sid, PB)) {
    Runtime.trap("14b: a different principal must be rejected for someone else's reserved sid");
  };
  let anon = Principal.anonymous();
  if (Transport.isAuthorizedSid(Transport.sidFor(Transport.ANON_SID_PREFIX, anon), anon)) {
    Runtime.trap("14c: the anonymous principal must never be authorized");
  };
  Debug.print("14. isAuthorizedSid() enforces the reserved namespace's own owner OK");
};

// ── 15. isAuthorizedSid(): the ANON_SID_PREFIX ("an:") namespace is enforced
//      exactly the same way as PRINCIPAL_SID_PREFIX ("ii:") ─────────────────
do {
  let anonSid = Transport.sidFor(Transport.ANON_SID_PREFIX, PA);
  if (not anonSid.startsWith(#text(Transport.ANON_SID_PREFIX))) {
    Runtime.trap("15a: sidFor(ANON_SID_PREFIX, ...) must fall in its own reserved namespace");
  };
  if (not Transport.isAuthorizedSid(anonSid, PA)) {
    Runtime.trap("15b: the owning principal must be authorized for its own an: sid");
  };
  if (Transport.isAuthorizedSid(anonSid, PB)) {
    Runtime.trap("15c: a different principal must be rejected for someone else's an: sid");
  };
  if (Transport.isAuthorizedSid("plain-agent-42", PA)) {
    Runtime.trap("15d: a sid in no recognized namespace must be rejected, not trusted");
  };
  if (Transport.isAuthorizedSid("plain-agent-42", PB)) {
    Runtime.trap("15e: ...for every principal, not just one");
  };
  Debug.print("15. isAuthorizedSid() enforces ANON_SID_PREFIX the same way, and rejects every unrecognized sid OK");
};

// ── 17. playerKey(): strips a recognized namespace prefix down to the bare
//      principal text, for a host that wants to key something (e.g. `mo:duel-
//      game-core/leaderboard`) per PLAYER rather than per session ───────────
do {
  let iiSid = Transport.sidForPrincipal(PA);
  let anSid = Transport.sidFor(Transport.ANON_SID_PREFIX, PA);
  if (Transport.playerKey(iiSid) != PA.toText()) {
    Runtime.trap("17a: playerKey() must strip the ii: prefix down to the bare principal text");
  };
  if (Transport.playerKey(anSid) != PA.toText()) {
    Runtime.trap("17b: playerKey() must strip the an: prefix the same way");
  };
  if (Transport.playerKey("cp:" # PA.toText() # ":7") != "cp:" # PA.toText() # ":7") {
    Runtime.trap("17c: an unrecognized (e.g. cp:) sid must be returned unchanged, not mangled");
  };
  Debug.print("17. playerKey() strips ii:/an: prefixes and leaves anything else alone OK");
};

// ── 18. isFreshMatch(): the field combination `OnGameStarted` fires on ─────
do {
  func active(pending1 : ?Nat, pending2 : ?Nat, turn : Nat, lastActivity : Int) : TP.Active<Nat, Nat> = {
    p1 = "sid-1";
    p2 = "sid-2";
    game = 0;
    pending1;
    pending2;
    turn;
    lastActivity;
    roundStartedAt = lastActivity;
    lastMoveP1 = null;
    lastMoveP2 = null;
    lastRoundDurationNs = null;
  };
  if (not Transport.isFreshMatch(active(null, null, 0, 100), 100)) {
    Runtime.trap("18a: turn=0, no pending, lastActivity==now must read as a fresh match");
  };
  if (Transport.isFreshMatch(active(?7, null, 0, 100), 100)) {
    Runtime.trap("18b: a pending move (round 1's first partial submit) must NOT read as fresh");
  };
  if (Transport.isFreshMatch(active(null, ?7, 0, 100), 100)) {
    Runtime.trap("18c: ...whichever seat's move is pending");
  };
  if (Transport.isFreshMatch(active(null, null, 1, 100), 100)) {
    Runtime.trap("18d: turn > 0 (a later, resolved round) must NOT read as fresh");
  };
  if (Transport.isFreshMatch(active(null, null, 0, 50), 100)) {
    Runtime.trap("18e: an untouched table this call (lastActivity != now) must NOT read as fresh");
  };
  Debug.print("18. isFreshMatch() identifies exactly the brand-new-match shape OK");
};

Debug.print("ALL HUB CHECKS PASSED");
