import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Option "mo:core/Option";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Text "mo:core/Text";

import Png "./Png";
import T "./Types";

/// Pure logic over the aggregator's own state: profiles (display names)
/// and the game registry, keyed by developer/backend-canister principal.
/// No `Time` import — `now` is a parameter everywhere a timestamp is
/// needed, same discipline `../../backend`'s own engine modules follow,
/// so this module is exercisable from a plain interpreter test (see
/// `../test/Store.test.mo`) without an actor at all. `Main.mo` is the
/// only place that calls `Time.now()` and reads `msg.caller`.
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

  /// Exposed as a query (`Main.mo`'s `getBannerRequirements`) so the
  /// frontend's own upload form validates against the SAME numbers this
  /// module actually enforces, rather than a hand-copied constant that
  /// could silently drift out of sync.
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

  public func getProfile(self : State, who : Principal) : ?T.Profile = Map.get(self.profiles, Principal.compare, who);

  public func setDisplayName(self : State, caller : Principal, name : Text) : Res<()> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousCaller);
    let trimmed = Text.trim(name, #char ' ');
    if (trimmed.size() == 0) return #err(#emptyDisplayName);
    if (trimmed.size() > MAX_DISPLAY_NAME) return #err(#displayNameTooLong);
    Map.add(self.profiles, Principal.compare, caller, { displayName = trimmed });
    #ok(());
  };

  // ── Games ──────────────────────────────────────────────────────────────

  func validateBanner(banner : Blob) : ?T.Err {
    if (banner.size() == 0 or banner.size() > BANNER_MAX_BYTES) {
      ?#invalidBanner("banner must be a PNG file of at most " # Nat.toText(BANNER_MAX_BYTES) # " bytes");
    } else {
      switch (Png.dimensions(banner)) {
        case null ?#invalidBanner("banner must be a valid PNG file");
        case (?(w, h)) {
          if (w != BANNER_WIDTH or h != BANNER_HEIGHT) {
            ?#invalidBanner(
              "banner must be exactly " # Nat.toText(BANNER_WIDTH) # "x" #
              Nat.toText(BANNER_HEIGHT) # " pixels (got " # Nat.toText(w) #
              "x" # Nat.toText(h) # ")"
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
          not (Text.startsWith(d, #text "https://") or Text.startsWith(d, #text "http://"))
        ) ?#invalidCustomDomain else null;
      };
    };
  };

  /// `null` for an empty string (treated the same as not supplying one),
  /// otherwise the domain unchanged — callers store the result directly.
  func normalizeCustomDomain(domain : ?Text) : ?Text {
    switch domain {
      case (?d) if (d.size() == 0) null else ?d;
      case null null;
    };
  };

  func toView(self : State, g : T.Game) : T.GameView = {
    developer = g.developer;
    developerDisplayName = Option.map<T.Profile, Text>(getProfile(self, g.developer), func(p) = p.displayName);
    title = g.title;
    description = g.description;
    backendCanisterId = g.backendCanisterId;
    frontendCanisterId = g.frontendCanisterId;
    customDomain = g.customDomain;
    createdAt = g.createdAt;
    updatedAt = g.updatedAt;
  };

  public func registerGame(self : State, caller : Principal, now : Int, input : T.GameInput) : Res<T.GameId> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousCaller);
    let title = Text.trim(input.title, #char ' ');
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
    if (Map.containsKey(self.games, Principal.compare, input.backendCanisterId)) {
      return #err(#gameAlreadyRegistered);
    };
    let game : T.Game = {
      developer = caller;
      title;
      description = input.description;
      backendCanisterId = input.backendCanisterId;
      frontendCanisterId = input.frontendCanisterId;
      customDomain = normalizeCustomDomain(input.customDomain);
      banner = input.banner;
      createdAt = now;
      updatedAt = now;
    };
    Map.add(self.games, Principal.compare, input.backendCanisterId, game);
    #ok(input.backendCanisterId);
  };

  public func updateGame(self : State, caller : Principal, now : Int, id : T.GameId, edit : T.GameEdit) : Res<()> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousCaller);
    let existing = switch (Map.get(self.games, Principal.compare, id)) {
      case null return #err(#noSuchGame);
      case (?g) g;
    };
    if (existing.developer != caller) return #err(#notOwner);
    let title = Text.trim(edit.title, #char ' ');
    if (title.size() == 0) return #err(#emptyTitle);
    if (title.size() > MAX_TITLE) return #err(#titleTooLong);
    if (edit.description.size() > MAX_DESCRIPTION) return #err(#descriptionTooLong);
    switch (validateCustomDomain(edit.customDomain)) {
      case (?e) return #err(e);
      case null {};
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
    Map.add(self.games, Principal.compare, id, updated);
    #ok(());
  };

  public func getGame(self : State, id : T.GameId) : ?T.GameView = Option.map<T.Game, T.GameView>(Map.get(self.games, Principal.compare, id), func(g) = toView(self, g));

  public func getBanner(self : State, id : T.GameId) : ?Blob = Option.map<T.Game, Blob>(Map.get(self.games, Principal.compare, id), func(g) = g.banner);

  public func listGames(self : State) : [T.GameView] {
    let out = List.empty<T.GameView>();
    for (g in Map.values(self.games)) { List.add(out, toView(self, g)) };
    List.toArray(out);
  };

  public func listGamesByDeveloper(self : State, developer : Principal) : [T.GameView] {
    let out = List.empty<T.GameView>();
    for (g in Map.values(self.games)) {
      if (g.developer == developer) { List.add(out, toView(self, g)) };
    };
    List.toArray(out);
  };

  /// Permanently removes a game from the registry. Only the developer who
  /// registered it (`existing.developer == caller`) may do this — same
  /// ownership gate `updateGame` enforces, and the same two error arms
  /// (`#noSuchGame`/`#notOwner`), so no new `Err` case was needed for it.
  public func deregisterGame(self : State, caller : Principal, id : T.GameId) : Res<()> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousCaller);
    let existing = switch (Map.get(self.games, Principal.compare, id)) {
      case null return #err(#noSuchGame);
      case (?g) g;
    };
    if (existing.developer != caller) return #err(#notOwner);
    Map.remove(self.games, Principal.compare, id);
    #ok(());
  };
};
