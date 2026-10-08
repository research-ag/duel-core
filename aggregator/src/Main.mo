import Time "mo:core/Time";

import Store "Store";
import T "Types";

/// The aggregator backend: developer profiles and a public game registry.
/// Plain Candid methods are fine here (no two callers contend on one
/// record the way two seats do on a table); all logic lives in `Store.mo`.
actor {

  let state : Store.State = Store.empty();

  public shared ({ caller }) func setDisplayName(name : Text) : async Store.Res<()> {
    state.setDisplayName(caller, name);
  };

  public query func getProfile(who : Principal) : async ?T.Profile {
    state.getProfile(who);
  };

  public query func getBannerRequirements() : async Store.BannerRequirements {
    Store.bannerRequirements();
  };

  public shared ({ caller }) func registerGame(input : T.GameInput) : async Store.Res<T.GameId> {
    state.registerGame(caller, Time.now(), input);
  };

  public shared ({ caller }) func updateGame(id : T.GameId, edit : T.GameEdit) : async Store.Res<()> {
    state.updateGame(caller, Time.now(), id, edit);
  };

  public shared ({ caller }) func deregisterGame(id : T.GameId) : async Store.Res<()> {
    state.deregisterGame(caller, id);
  };

  public query func listGames() : async [T.GameView] {
    state.listGames();
  };

  public query func listGamesByDeveloper(developer : Principal) : async [T.GameView] {
    state.listGamesByDeveloper(developer);
  };

  public query func getGame(id : T.GameId) : async ?T.GameView {
    state.getGame(id);
  };

  /// Separate from `getGame`/`listGames` so browsing the grid doesn't
  /// ship every banner's bytes in one response.
  public query func getBanner(id : T.GameId) : async ?Blob {
    state.getBanner(id);
  };
};
