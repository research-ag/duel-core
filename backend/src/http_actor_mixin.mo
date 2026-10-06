/// Supplies `http_request` over `mo:duel-game-core/http` routes (every
/// host serves its rules text at `Http.SEMANTICS_PATH`) and makes the
/// backend pullable: controllers upload the running module with
/// `wasm_upload_begin`/`wasm_upload_chunk`/`wasm_upload_commit`, and
/// anyone downloads it at `Http.WASM_PATH`. See README, "Pullable
/// backend".
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Http "./http";
import Wasm "./wasm";

mixin (routes : [Http.Route]) {

  let wasm : Wasm.Store = Wasm.new();

  func controllersOnly(caller : Principal) {
    if (not Principal.isController(caller)) Runtime.trap("Controllers only");
  };

  public shared ({ caller }) func wasm_upload_begin() : async () {
    controllersOnly(caller);
    Wasm.begin(wasm);
  };

  public shared ({ caller }) func wasm_upload_chunk(chunk : Blob) : async () {
    controllersOnly(caller);
    Wasm.append(wasm, chunk);
  };

  /// `size` is the whole module's byte count; a mismatch keeps the
  /// previous module.
  public shared ({ caller }) func wasm_upload_commit(size : Nat) : async () {
    controllersOnly(caller);
    if (not Wasm.commit(wasm, size)) Runtime.trap("Uploaded chunks do not add up to " # debug_show size # " bytes");
  };

  public query func http_request_streaming_callback(token : Http.StreamingToken) : async Http.StreamingCallbackResponse {
    Wasm.stream(wasm, token);
  };

  public query func http_request(req : Http.Request) : async Http.Response {
    if (req.method == "GET" and Http.path(req) == ?Http.WASM_PATH) {
      return Wasm.respond(wasm, http_request_streaming_callback);
    };
    Http.respond(routes, req);
  };

};
