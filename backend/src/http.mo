/// Plain-text HTTP routing for a host's `http_request`. See README,
/// "Semantics over HTTP".
import Text "mo:core/Text";

module {

  public type Request = {
    method : Text;
    url : Text;
    headers : [(Text, Text)];
    body : Blob;
  };

  public type Response = {
    status_code : Nat16;
    headers : [(Text, Text)];
    body : Blob;
  };

  /// A path and the text `GET <path>` answers with.
  public type Route = (Text, () -> Text);

  public let SEMANTICS_PATH : Text = "/semantics";

  func plain(status_code : Nat16, text : Text) : Response = {
    status_code;
    headers = [("content-type", "text/plain; charset=utf-8")];
    body = text.encodeUtf8();
  };

  /// `GET` on a route's path answers its text; any other path answers a
  /// 404 listing the routes.
  public func respond(routes : [Route], req : Request) : Response {
    if (req.method != "GET") return plain(405, "GET only");
    let ?path = req.url.split(#char '?').next() else return plain(400, "Invalid request");
    for ((route, text) in routes.values()) {
      if (route == path) return plain(200, text());
    };
    var known = "Not found. Available:";
    for ((route, _) in routes.values()) known #= "\n" # route;
    plain(404, known);
  };
};
