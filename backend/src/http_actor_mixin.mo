/// Supplies `http_request` over `mo:duel-game-core/http` routes; every
/// host serves its rules text at `Http.SEMANTICS_PATH`. See README,
/// "Semantics over HTTP".
import Http "./http";

mixin (routes : [Http.Route]) {

  /// Answers `GET` on a route's path with its text; see `Http.respond`.
  public query func http_request(req : Http.Request) : async Http.Response {
    Http.respond(routes, req);
  };

};
