import Time "mo:core/Time";

import Store "Store";
import T "Types";

/// The aggregator backend: Internet Identity-keyed developer profiles
/// (display name only) plus a public registry of games built with this
/// repo's tooling. Unlike `../../backend`'s own `Registry`, there is no
/// real-time race to close here — every method here is a plain, ordinary
/// Candid method (no `ws.mo`-style single-channel requirement), since a
/// game registration/edit from one developer never contends with another
/// developer's own edit the way two seats submitting into the SAME table
/// do (see `../../CLAUDE.md`'s rule 11, which is about `../../backend`
/// specifically, not this actor).
///
/// All mutating logic and validation lives in `Store.mo`, as plain
/// functions over an explicit `Store.State` — this actor's own job is
/// just to own that state, read `msg.caller`/`Time.now()`, and forward.
persistent actor {

  let state : Store.State = Store.empty();

  // ── Profiles ───────────────────────────────────────────────────────────

  public shared ({ caller }) func setDisplayName(name : Text) : async Store.Res<()> {
    Store.setDisplayName(state, caller, name);
  };

  public query func getProfile(who : Principal) : async ?T.Profile {
    Store.getProfile(state, who);
  };

  /// The exact PNG width/height/max-byte-size a banner upload must meet
  /// — see `Store.bannerRequirements`'s own doc for why this is a method
  /// rather than a value the frontend hardcodes.
  public query func getBannerRequirements() : async Store.BannerRequirements {
    Store.bannerRequirements();
  };

  // ── Games ──────────────────────────────────────────────────────────────

  public shared ({ caller }) func registerGame(input : T.GameInput) : async Store.Res<T.GameId> {
    Store.registerGame(state, caller, Time.now(), input);
  };

  public shared ({ caller }) func updateGame(id : T.GameId, edit : T.GameEdit) : async Store.Res<()> {
    Store.updateGame(state, caller, Time.now(), id, edit);
  };

  public shared ({ caller }) func deregisterGame(id : T.GameId) : async Store.Res<()> {
    Store.deregisterGame(state, caller, id);
  };

  public query func listGames() : async [T.GameView] {
    Store.listGames(state);
  };

  public query func listGamesByDeveloper(developer : Principal) : async [T.GameView] {
    Store.listGamesByDeveloper(state, developer);
  };

  public query func getGame(id : T.GameId) : async ?T.GameView {
    Store.getGame(state, id);
  };

  /// Kept off `getGame`/`listGames`' own return shape so browsing the
  /// grid doesn't ship every banner's raw PNG bytes in one Candid
  /// response — the frontend calls this once per card it actually
  /// renders instead. See `Types.mo`'s `GameView` doc.
  public query func getBanner(id : T.GameId) : async ?Blob {
    Store.getBanner(state, id);
  };
};
