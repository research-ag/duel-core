import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";

import Png "./Png";
import T "./Types";

/// Pure logic over the aggregator's state. `now` is a parameter; only
/// `Main.mo` calls `Time.now()` and reads `msg.caller`.
module {

  public let BANNER_WIDTH : Nat = 800;
  public let BANNER_HEIGHT : Nat = 400;
  public let BANNER_MAX_BYTES : Nat = 1_000_000;
  public let MAX_DISPLAY_NAME : Nat = 40;
  public let MAX_TITLE : Nat = 60;
  public let MAX_DESCRIPTION : Nat = 500;
  public let MAX_CUSTOM_DOMAIN : Nat = 200;

  public type State = {
    var profiles : Map.Map<Principal, T.Profile>;
    var games : Map.Map<Principal, T.Game>;
  };

  public type Res<Ok> = Result.Result<Ok, T.Err>;

  public type BannerRequirements = { width : Nat; height : Nat; maxBytes : Nat };

  /// Exposed as a query so the frontend validates against these numbers.
  public func bannerRequirements() : BannerRequirements = {
    width = BANNER_WIDTH;
    height = BANNER_HEIGHT;
    maxBytes = BANNER_MAX_BYTES;
  };

  public func empty() : State = {
    var profiles = Map.empty<Principal, T.Profile>();
    var games = Map.empty<Principal, T.Game>();
  };

  // ── Profiles ───────────────────────────────────────────────────────────

  public func getProfile(self : State, who : Principal) : ?T.Profile = self.profiles.get(who);

  public func setDisplayName(self : State, caller : Principal, name : Text) : Res<()> {
    if (caller.isAnonymous()) return #err(#anonymousCaller);
    let trimmed = name.trim(#char ' ');
    if (trimmed.size() == 0) return #err(#emptyDisplayName);
    if (trimmed.size() > MAX_DISPLAY_NAME) return #err(#displayNameTooLong);
    self.profiles.add(caller, { displayName = trimmed });
    #ok(());
  };

  // ── Games ──────────────────────────────────────────────────────────────

  func validateBanner(banner : Blob) : ?T.Err {
    if (banner.size() == 0 or banner.size() > BANNER_MAX_BYTES) {
      ?#invalidBanner("banner must be a PNG file of at most " # BANNER_MAX_BYTES.toText() # " bytes");
    } else {
      switch (Png.dimensions(banner)) {
        case null ?#invalidBanner("banner must be a valid PNG file");
        case (?(w, h)) {
          if (w != BANNER_WIDTH or h != BANNER_HEIGHT) {
            ?#invalidBanner(
              "banner must be exactly " # BANNER_WIDTH.toText() # "x" #
              BANNER_HEIGHT.toText() # " pixels (got " # w.toText() #
              "x" # h.toText() # ")"
            );
          } else null;
        };
      };
    };
  };

  func validateCustomDomain(domain : ?Text) : ?T.Err {
    switch domain {
      case null null;
      case (?d) {
        if (d.size() == 0 or d.size() > MAX_CUSTOM_DOMAIN) ?#invalidCustomDomain else if (
          not (d.startsWith(#text "https://") or d.startsWith(#text "http://"))
        ) ?#invalidCustomDomain else null;
      };
    };
  };

  func normalizeCustomDomain(domain : ?Text) : ?Text {
    switch domain {
      case (?d) if (d.size() == 0) null else ?d;
      case null null;
    };
  };

  func toView(self : State, g : T.Game) : T.GameView = {
    developer = g.developer;
    developerDisplayName = self.getProfile(g.developer).map(func(p) = p.displayName);
    title = g.title;
    description = g.description;
    frontendCanisterId = g.frontendCanisterId;
    customDomain = g.customDomain;
    createdAt = g.createdAt;
    updatedAt = g.updatedAt;
  };

  public func registerGame(self : State, caller : Principal, now : Int, input : T.GameInput) : Res<T.GameId> {
    if (caller.isAnonymous()) return #err(#anonymousCaller);
    let title = input.title.trim(#char ' ');
    if (title.size() == 0) return #err(#emptyTitle);
    if (title.size() > MAX_TITLE) return #err(#titleTooLong);
    if (input.description.size() > MAX_DESCRIPTION) return #err(#descriptionTooLong);
    switch (validateCustomDomain(input.customDomain)) {
      case (?e) return #err(e);
      case null {};
    };
    switch (validateBanner(input.banner)) {
      case (?e) return #err(e);
      case null {};
    };
    if (self.games.containsKey(input.frontendCanisterId)) {
      return #err(#gameAlreadyRegistered);
    };
    let game : T.Game = {
      developer = caller;
      title;
      description = input.description;
      frontendCanisterId = input.frontendCanisterId;
      customDomain = normalizeCustomDomain(input.customDomain);
      banner = input.banner;
      createdAt = now;
      updatedAt = now;
    };
    self.games.add(input.frontendCanisterId, game);
    #ok(input.frontendCanisterId);
  };

  public func updateGame(self : State, caller : Principal, now : Int, id : T.GameId, edit : T.GameEdit) : Res<()> {
    if (caller.isAnonymous()) return #err(#anonymousCaller);
    let existing = switch (self.games.get(id)) {
      case null return #err(#noSuchGame);
      case (?g) g;
    };
    if (existing.developer != caller) return #err(#notOwner);
    let title = edit.title.trim(#char ' ');
    if (title.size() == 0) return #err(#emptyTitle);
    if (title.size() > MAX_TITLE) return #err(#titleTooLong);
    if (edit.description.size() > MAX_DESCRIPTION) return #err(#descriptionTooLong);
    switch (validateCustomDomain(edit.customDomain)) {
      case (?e) return #err(e);
      case null {};
    };
    let moved = edit.frontendCanisterId != id;
    if (moved and self.games.containsKey(edit.frontendCanisterId)) {
      return #err(#gameAlreadyRegistered);
    };
    let banner = switch (edit.banner) {
      case null existing.banner;
      case (?b) {
        switch (validateBanner(b)) {
          case (?e) return #err(e);
          case null {};
        };
        b;
      };
    };
    let updated : T.Game = {
      existing with
      title;
      description = edit.description;
      frontendCanisterId = edit.frontendCanisterId;
      customDomain = normalizeCustomDomain(edit.customDomain);
      banner;
      updatedAt = now;
    };
    if (moved) self.games.remove(id);
    self.games.add(edit.frontendCanisterId, updated);
    #ok(());
  };

  public func getGame(self : State, id : T.GameId) : ?T.GameView = self.games.get(id).map(func(g) = toView(self, g));

  public func getBanner(self : State, id : T.GameId) : ?Blob = self.games.get(id).map(func(g) = g.banner);

  public func listGames(self : State) : [T.GameView] {
    let out = List.empty<T.GameView>();
    for (g in self.games.values()) { out.add(toView(self, g)) };
    out.toArray();
  };

  public func listGamesByDeveloper(self : State, developer : Principal) : [T.GameView] {
    let out = List.empty<T.GameView>();
    for (g in self.games.values()) {
      if (g.developer == developer) { out.add(toView(self, g)) };
    };
    out.toArray();
  };

  public func deregisterGame(self : State, caller : Principal, id : T.GameId) : Res<()> {
    if (caller.isAnonymous()) return #err(#anonymousCaller);
    let ?existing = self.games.get(id) else return #err(#noSuchGame);
    if (existing.developer != caller) return #err(#notOwner);
    self.games.remove(id);
    #ok(());
  };
};
