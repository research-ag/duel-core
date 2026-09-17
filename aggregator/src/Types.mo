/// Shared type surface for the aggregator: a developer profile (display
/// name only, keyed by the caller's own Internet Identity principal) and
/// a game registry record. Kept in its own module — no `Time` import, no
/// `Map`/state — so `Store.mo`'s pure logic and `Main.mo`'s actor wiring
/// both name these types off one import, mirroring how `../../backend`
/// itself splits `types.mo` from its own logic modules.
module {

  public type Profile = {
    displayName : Text;
  };

  /// A game is keyed by its own `backendCanisterId` (see `Store.mo`'s
  /// `State.games`) — that field is immutable for the record's lifetime,
  /// so the key can never drift out of sync with the record it names,
  /// and there is no separate incrementing id to keep straight.
  public type GameId = Principal;

  public type Game = {
    developer : Principal;
    title : Text;
    description : Text;
    backendCanisterId : Principal;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    banner : Blob; // PNG, exactly Store.BANNER_WIDTH x Store.BANNER_HEIGHT
    createdAt : Int;
    updatedAt : Int;
  };

  /// What `listGames`/`getGame` actually return: every field of `Game`
  /// except the banner blob itself (fetched separately via `getBanner` —
  /// see `Main.mo`'s doc header for why), plus the developer's own
  /// display name resolved server-side so the frontend doesn't need one
  /// round trip per distinct developer just to render a grid.
  public type GameView = {
    developer : Principal;
    developerDisplayName : ?Text;
    title : Text;
    description : Text;
    backendCanisterId : Principal;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    createdAt : Int;
    updatedAt : Int;
  };

  /// `registerGame`'s input. `backendCanisterId` becomes the game's
  /// permanent `GameId` — never part of `GameEdit` below.
  public type GameInput = {
    title : Text;
    description : Text;
    backendCanisterId : Principal;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    banner : Blob;
  };

  /// `updateGame`'s input — everything an owner may change about their
  /// own game after registration. `banner = null` leaves the existing
  /// banner untouched (so an edit that only changes, say, the
  /// description doesn't force a re-upload).
  public type GameEdit = {
    title : Text;
    description : Text;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    banner : ?Blob;
  };

  public type Err = {
    #anonymousCaller;
    #emptyDisplayName;
    #displayNameTooLong;
    #emptyTitle;
    #titleTooLong;
    #descriptionTooLong;
    #invalidCustomDomain;
    #invalidBanner : Text;
    #gameAlreadyRegistered;
    #noSuchGame;
    #notOwner;
  };
};
