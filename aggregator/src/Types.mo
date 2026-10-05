/// Shared type surface for the aggregator, kept free of `Time`/state so
/// `Store.mo` and `Main.mo` name these off one import.
module {

  public type Profile = {
    displayName : Text;
  };

  /// A game is keyed by its `frontendCanisterId`.
  public type GameId = Principal;

  public type Game = {
    developer : Principal;
    title : Text;
    description : Text;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    banner : Blob; // PNG, exactly Store.BANNER_WIDTH x Store.BANNER_HEIGHT
    createdAt : Int;
    updatedAt : Int;
  };

  /// What `listGames`/`getGame` return: `Game` minus the banner blob
  /// (fetched via `getBanner`), plus the developer's display name.
  public type GameView = {
    developer : Principal;
    developerDisplayName : ?Text;
    title : Text;
    description : Text;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    createdAt : Int;
    updatedAt : Int;
  };

  public type GameInput = {
    title : Text;
    description : Text;
    frontendCanisterId : Principal;
    customDomain : ?Text;
    banner : Blob;
  };

  /// `banner = null` leaves the existing banner untouched.
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
