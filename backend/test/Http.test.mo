// Unit checks for `http.mo`'s plain-text routing.
import Http "../src/http";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";

let routes : [Http.Route] = [
  (Http.SEMANTICS_PATH, func() : Text = "GAME: fake"),
  ("/metrics", func() : Text = "up 1"),
];

func get(method : Text, url : Text) : Http.Response {
  Http.respond(routes, { method; url; headers = []; body = "" });
};

func expect(r : Http.Response, status : Nat16, body : Text, msg : Text) {
  if (r.status_code != status) {
    Runtime.trap(msg # ": got status " # debug_show (r.status_code) # ", want " # debug_show (status));
  };
  if (Text.decodeUtf8(r.body) != ?body) {
    Runtime.trap(msg # ": got body " # debug_show (Text.decodeUtf8(r.body)) # ", want " # debug_show (body));
  };
};

// ── 1. A route's path answers its text as text/plain ───────────────────────
do {
  let r = get("GET", "/semantics");
  expect(r, 200, "GAME: fake", "1a: the semantics route");
  if (r.headers != [("content-type", "text/plain; charset=utf-8")]) {
    Runtime.trap("1b: a route answers text/plain, got " # debug_show (r.headers));
  };
  expect(get("GET", "/metrics"), 200, "up 1", "1c: a second route");
  Debug.print("1. a route answers its text OK");
};

// ── 2. The query string is ignored when matching ───────────────────────────
do {
  expect(get("GET", "/semantics?v=2"), 200, "GAME: fake", "2a: query string stripped");
  Debug.print("2. query string ignored OK");
};

// ── 3. An unknown path is a 404 that lists every route ─────────────────────
do {
  let listing = "Not found. Available:\n/semantics\n/metrics\n/wasm";
  expect(get("GET", "/"), 404, listing, "3a: root");
  expect(get("GET", "/semantics/"), 404, listing, "3b: no prefix match");
  Debug.print("3. unknown path lists the routes and /wasm OK");
};

// ── 4. Only GET is served ──────────────────────────────────────────────────
do {
  expect(get("POST", "/semantics"), 405, "GET only", "4a: POST rejected");
  Debug.print("4. non-GET rejected OK");
};

// ── 5. A plain response never streams; `path` drops the query string ───────
do {
  if (get("GET", "/semantics").streaming_strategy != null) {
    Runtime.trap("5a: a text route must not set a streaming strategy");
  };
  if (Http.path({ method = "GET"; url = "/wasm?x=1"; headers = []; body = "" }) != ?"/wasm") {
    Runtime.trap("5b: path keeps the query string");
  };
  Debug.print("5. plain responses and path OK");
};

Debug.print("ALL HTTP CHECKS PASSED");
