// Interpreter-run suite for Png.mo's header parsing and Store.mo's pure
// registration/edit/profile logic — no actor involved (see Store.mo's own
// doc header for why). Run: moc -r --package core <core/src> test/Store.test.mo
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Png "../src/Png";
import Store "../src/Store";
import T "../src/Types";

// ── Fixtures ───────────────────────────────────────────────────────────

// Real, well-known mainnet canister principals, used here purely as
// distinct opaque test values (never actually called).
let DEV_A = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let DEV_B = Principal.fromText("rwlgt-iiaaa-aaaaa-aaaaa-cai");
let FRONTEND_1 = Principal.fromText("rno2w-sqaaa-aaaaa-aaacq-cai");
let FRONTEND_3 = Principal.fromText("qoctq-giaaa-aaaaa-aaaea-cai");
let FRONTEND_2 = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");

let T0 : Int = 1_000_000_000_000;
let T1 : Int = 1_000_000_500_000;

func u32beBytes(n : Nat) : [Nat8] = [
  ((n / 16_777_216) % 256).toNat8(),
  ((n / 65_536) % 256).toNat8(),
  ((n / 256) % 256).toNat8(),
  (n % 256).toNat8(),
];

/// A blob with a real PNG signature + IHDR chunk announcing `w`x`h` —
/// enough for `Png.dimensions`/`Store`'s validation, which never reads
/// past byte 24 (see Png.mo's own doc header for why the rest of a real
/// PNG file is irrelevant to it).
func pngWithSize(w : Nat, h : Nat) : Blob {
  let sig : [Nat8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  let chunkHeader : [Nat8] = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]; // length=13, "IHDR"
  let padding = Array.repeat<Nat8>(0, 5); // bit depth/color/etc — unread by our validator
  [sig, chunkHeader, u32beBytes(w), u32beBytes(h), padding].flatten<Nat8>().toBlob();
};

let VALID_BANNER = pngWithSize(Store.BANNER_WIDTH, Store.BANNER_HEIGHT);
let WRONG_SIZE_BANNER = pngWithSize(100, 100);
let NOT_A_PNG = "\00\01\02\03\04\05\06\07\08\09\10\11\12\13\14\15\16\17\18\19\20\21\22\23" : Blob;

let baseInput : T.GameInput = {
  title = "Duel 007";
  description = "A tense two-player standoff.";
  frontendCanisterId = FRONTEND_1;
  customDomain = null;
  banner = VALID_BANNER;
};

// ── Helpers ────────────────────────────────────────────────────────────

func ok<Ok>(r : Store.Res<Ok>, msg : Text) : Ok = switch r {
  case (#ok v) v;
  case (#err e) Runtime.trap(msg # " unexpectedly failed: " # debug_show (e));
};

func expectErr<Ok>(r : Store.Res<Ok>, want : T.Err, msg : Text) = switch r {
  case (#ok _) Runtime.trap(msg # " unexpectedly succeeded");
  case (#err e) if (e != want) {
    Runtime.trap(msg # ": expected " # debug_show (want) # ", got " # debug_show (e));
  };
};

// ── Png.dimensions ───────────────────────────────────────────────────────

switch (Png.dimensions(pngWithSize(800, 400))) {
  case (?(800, 400)) {};
  case (_) Runtime.trap("1. a well-formed IHDR must round-trip its own width/height");
};
if (Png.dimensions(NOT_A_PNG) != null) {
  Runtime.trap("2. bytes without the PNG signature must not report dimensions");
};
if (Png.dimensions("\89\50\4E\47\0D\0A\1A\0A" : Blob) != null) {
  Runtime.trap("3. a truncated file (signature only, no IHDR) must not report dimensions");
};
Debug.print("1-3. Png.dimensions OK");

// ── setDisplayName / getProfile ──────────────────────────────────────────

do {
  let s = Store.empty();
  expectErr<()>(s.setDisplayName(Principal.anonymous(), "anon"), #anonymousCaller, "4a");
  expectErr<()>(s.setDisplayName(DEV_A, "   "), #emptyDisplayName, "4b");
  expectErr<()>(
    s.setDisplayName(DEV_A, "this display name is deliberately far too long to accept"),
    #displayNameTooLong,
    "4c",
  );
  ok(s.setDisplayName(DEV_A, "  Ada  "), "4d");
  switch (s.getProfile(DEV_A)) {
    case (?p) if (p.displayName != "Ada") Runtime.trap("4e: display name must be trimmed");
    case null Runtime.trap("4e: profile must exist after setDisplayName");
  };
  if (s.getProfile(DEV_B) != null) Runtime.trap("4f: an unrelated principal must have no profile");
  ok(s.setDisplayName(DEV_A, "Ada Lovelace"), "4g: re-setting must overwrite, not error");
  switch (s.getProfile(DEV_A)) {
    case (?p) if (p.displayName != "Ada Lovelace") Runtime.trap("4h: overwrite must take effect");
    case null Runtime.trap("4h: profile must still exist");
  };
};
Debug.print("4. setDisplayName / getProfile OK");

// ── registerGame ──────────────────────────────────────────────────────────

do {
  let s = Store.empty();
  expectErr<T.GameId>(s.registerGame(Principal.anonymous(), T0, baseInput), #anonymousCaller, "5a");
  expectErr<T.GameId>(s.registerGame(DEV_A, T0, { baseInput with title = "   " }), #emptyTitle, "5b");
  expectErr<T.GameId>(
    s.registerGame(DEV_A, T0, { baseInput with banner = WRONG_SIZE_BANNER }),
    #invalidBanner("banner must be exactly 800x400 pixels (got 100x100)"),
    "5c",
  );
  expectErr<T.GameId>(
    s.registerGame(DEV_A, T0, { baseInput with banner = NOT_A_PNG }),
    #invalidBanner("banner must be a valid PNG file"),
    "5d",
  );
  expectErr<T.GameId>(
    s.registerGame(DEV_A, T0, { baseInput with customDomain = ?"ftp://not-http" }),
    #invalidCustomDomain,
    "5e",
  );
  let id = ok(s.registerGame(DEV_A, T0, baseInput), "5f");
  if (id != FRONTEND_1) Runtime.trap("5f: the game's id must be its frontendCanisterId");
  expectErr<T.GameId>(
    s.registerGame(DEV_B, T1, { baseInput with title = "Another" }),
    #gameAlreadyRegistered,
    "5g: a second registration under the SAME frontendCanisterId must be rejected, even from another caller",
  );
};
Debug.print("5. registerGame OK");

// ── updateGame ────────────────────────────────────────────────────────────

do {
  let s = Store.empty();
  ignore ok(s.registerGame(DEV_A, T0, baseInput), "6 setup");

  expectErr<()>(
    s.updateGame(DEV_A, T1, FRONTEND_2, { title = "x"; description = ""; frontendCanisterId = FRONTEND_2; customDomain = null; banner = null }),
    #noSuchGame,
    "6a",
  );
  expectErr<()>(
    s.updateGame(DEV_B, T1, FRONTEND_1, { title = "hijacked"; description = ""; frontendCanisterId = FRONTEND_1; customDomain = null; banner = null }),
    #notOwner,
    "6b",
  );

  let edit : T.GameEdit = {
    title = "Duel 007: Reloaded";
    description = "Updated blurb.";
    frontendCanisterId = FRONTEND_2;
    customDomain = ?"https://duel007.example.com";
    banner = null; // keep the existing banner
  };
  ok(s.updateGame(DEV_A, T1, FRONTEND_1, edit), "6c");

  if (s.getGame(FRONTEND_1) != null) Runtime.trap("6d: a moved game must leave its old id");
  let view = switch (s.getGame(FRONTEND_2)) {
    case (?v) v;
    case null Runtime.trap("6d: the game must still exist after editing");
  };
  if (view.title != "Duel 007: Reloaded") Runtime.trap("6e: title must update");
  if (view.frontendCanisterId != FRONTEND_2) Runtime.trap("6f: frontendCanisterId must be editable");
  if (s.listGames().size() != 1) Runtime.trap("6g: moving a game must not duplicate it");
  if (view.developer != DEV_A) Runtime.trap("6h: developer must stay fixed");

  switch (s.getBanner(FRONTEND_2)) {
    case (?b) if (b != VALID_BANNER) Runtime.trap("6i: banner = null on edit must leave the original banner untouched");
    case null Runtime.trap("6i: banner must still exist");
  };

  let newBanner = pngWithSize(Store.BANNER_WIDTH, Store.BANNER_HEIGHT);
  ok(s.updateGame(DEV_A, T1, FRONTEND_2, { edit with banner = ?newBanner }), "6j");
  switch (s.getBanner(FRONTEND_2)) {
    case (?b) if (b != newBanner) Runtime.trap("6k: a supplied banner must replace the old one");
    case null Runtime.trap("6k: banner must still exist");
  };

  expectErr<()>(
    s.updateGame(DEV_A, T1, FRONTEND_2, { edit with banner = ?WRONG_SIZE_BANNER }),
    #invalidBanner("banner must be exactly 800x400 pixels (got 100x100)"),
    "6l: an edit's own banner is validated exactly like registration's",
  );

  ignore ok(s.registerGame(DEV_B, T1, { baseInput with frontendCanisterId = FRONTEND_3 }), "6m setup");
  expectErr<()>(
    s.updateGame(DEV_A, T1, FRONTEND_2, { edit with frontendCanisterId = FRONTEND_3 }),
    #gameAlreadyRegistered,
    "6m: a game must not move onto another game's frontendCanisterId",
  );
  if (s.getGame(FRONTEND_2) == null) Runtime.trap("6n: a rejected move must leave the game in place");
};
Debug.print("6. updateGame OK");

// ── listGames / listGamesByDeveloper / developerDisplayName ──────────────

do {
  let s = Store.empty();
  ok(s.setDisplayName(DEV_A, "Ada"), "7 setup a");
  ignore ok(s.registerGame(DEV_A, T0, baseInput), "7 setup b");
  ignore ok(
    s.registerGame(DEV_B, T1, { baseInput with frontendCanisterId = FRONTEND_2 }),
    "7 setup c",
  );

  if (s.listGames().size() != 2) Runtime.trap("7a: both games must be listed");

  let byA = s.listGamesByDeveloper(DEV_A);
  if (byA.size() != 1 or byA[0].frontendCanisterId != FRONTEND_1) {
    Runtime.trap("7b: filtering by developer must return only that developer's games");
  };
  if (byA[0].developerDisplayName != ?"Ada") {
    Runtime.trap("7c: a game's view must resolve its developer's current display name");
  };

  let byB = s.listGamesByDeveloper(DEV_B);
  if (byB.size() != 1 or byB[0].developerDisplayName != null) {
    Runtime.trap("7d: a developer with no profile yet must show a null display name, not trap or default silently");
  };
};
Debug.print("7. listGames / listGamesByDeveloper / developerDisplayName OK");

// ── deregisterGame ────────────────────────────────────────────────────────

do {
  let s = Store.empty();
  ignore ok(s.registerGame(DEV_A, T0, baseInput), "8 setup");

  expectErr<()>(s.deregisterGame(Principal.anonymous(), FRONTEND_1), #anonymousCaller, "8a");
  expectErr<()>(s.deregisterGame(DEV_A, FRONTEND_2), #noSuchGame, "8b");
  expectErr<()>(s.deregisterGame(DEV_B, FRONTEND_1), #notOwner, "8c: only the developer who registered it may remove it");

  if (s.getGame(FRONTEND_1) == null) Runtime.trap("8d: a failed deregister must not remove the game");

  ok(s.deregisterGame(DEV_A, FRONTEND_1), "8e");
  if (s.getGame(FRONTEND_1) != null) Runtime.trap("8f: the game must be gone after deregistering");
  if (s.getBanner(FRONTEND_1) != null) Runtime.trap("8g: its banner must be gone too");
  if (s.listGames().size() != 0) Runtime.trap("8h: it must no longer be listed");

  expectErr<()>(s.deregisterGame(DEV_A, FRONTEND_1), #noSuchGame, "8i: deregistering an already-removed game must not succeed twice");
};
Debug.print("8. deregisterGame OK");

Debug.print("ALL STORE CHECKS PASSED");
