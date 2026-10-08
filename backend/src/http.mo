/// Plain-text HTTP routing for a host's `http_request`, plus the types a
/// streamed response needs (`GET /wasm`, see `wasm.mo`). See README,
/// "Semantics over HTTP" and "Downloadable wasm".
import Text "mo:core/Text";

module {

  public type Request = {
    method : Text;
    url : Text;
    headers : [(Text, Text)];
    body : Blob;
  };

  public type StreamingToken = { index : Nat };

  public type StreamingCallbackResponse = {
    body : Blob;
    token : ?StreamingToken;
  };

  public type StreamingCallback = shared query (StreamingToken) -> async StreamingCallbackResponse;

  public type StreamingStrategy = {
    #Callback : { callback : StreamingCallback; token : StreamingToken };
  };

  public type Response = {
    status_code : Nat16;
    headers : [(Text, Text)];
    body : Blob;
    streaming_strategy : ?StreamingStrategy;
  };

  /// A path and the text `GET <path>` answers with.
  public type Route = (Text, () -> Text);

  public let SEMANTICS_PATH : Text = "/semantics";

  /// Served by `HttpActorMixin` itself, never a host route.
  public let WASM_PATH : Text = "/wasm";

  public func plain(status_code : Nat16, text : Text) : Response = {
    status_code;
    headers = [("content-type", "text/plain; charset=utf-8")];
    body = text.encodeUtf8();
    streaming_strategy = null;
  };

  /// The request's path without its query string.
  public func path(req : Request) : ?Text = req.url.split(#char '?').next();

  /// `GET` on a route's path answers its text; any other path answers a
  /// 404 listing the routes and `WASM_PATH`.
  public func respond(routes : [Route], req : Request) : Response {
    if (req.method != "GET") return plain(405, "GET only");
    let ?p = path(req) else return plain(400, "Invalid request");
    for ((route, text) in routes.values()) {
      if (route == p) return plain(200, text());
    };
    var known = "Not found. Available:";
    for ((route, _) in routes.values()) known #= "\n" # route;
    known #= "\n" # WASM_PATH;
    plain(404, known);
  };
};
