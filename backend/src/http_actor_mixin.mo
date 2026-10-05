/// Supplies `http_request` over `mo:duel-game-core/http` routes; every
/// host serves its rules text at `Http.SEMANTICS_PATH`.
import Http "./http";

mixin (routes : [Http.Route]) {

  public query func http_request(req : Http.Request) : async Http.Response {
    Http.respond(routes, req);
  };

};
