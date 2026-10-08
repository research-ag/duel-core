/// The module a backend serves of itself at `GET /wasm`: uploaded in
/// chunks by its own deploy (`publish_wasm.sh`), kept in stable memory,
/// streamed back through the HTTP gateway. See README, "Downloadable
/// wasm".
import List "mo:core/List";

import Http "./http";

module {

  public type Store = {
    var live : [Blob];
    staged : List.List<Blob>;
  };

  public func new() : Store = { var live = []; staged = List.empty() };

  public func begin(s : Store) = List.clear(s.staged);

  public func append(s : Store, chunk : Blob) = List.add(s.staged, chunk);

  /// Replaces the served module with the staged chunks if they add up to
  /// `size` bytes; otherwise discards them and keeps the previous module.
  public func commit(s : Store, size : Nat) : Bool {
    var total = 0;
    for (c in List.values(s.staged)) total += c.size();
    let ok = total == size and size > 0;
    if (ok) s.live := List.toArray(s.staged);
    List.clear(s.staged);
    ok;
  };

  public func size(s : Store) : Nat {
    var total = 0;
    for (c in s.live.values()) total += c.size();
    total;
  };

  /// The first chunk in the body, the rest through `callback`.
  public func respond(s : Store, callback : Http.StreamingCallback) : Http.Response {
    if (s.live.size() == 0) return Http.plain(404, "No module uploaded yet");
    {
      status_code = 200;
      headers = [("content-type", "application/wasm")];
      body = s.live[0];
      streaming_strategy = if (s.live.size() > 1) ?#Callback({
        callback;
        token = { index = 1 };
      }) else null;
    };
  };

  public func stream(s : Store, token : Http.StreamingToken) : Http.StreamingCallbackResponse {
    if (token.index >= s.live.size()) return { body = ""; token = null };
    let next = token.index + 1;
    {
      body = s.live[token.index];
      token = if (next < s.live.size()) ?{ index = next } else null;
    };
  };
};
