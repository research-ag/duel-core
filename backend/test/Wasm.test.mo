// Unit checks for `wasm.mo`: the chunked upload and the streamed download.
import Wasm "../src/wasm";
import Http "../src/http";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let a : Blob = "\01\02\03";
let b : Blob = "\04\05";
let c : Blob = "\06";

// A stand-in for the mixin's `http_request_streaming_callback`.
let callback : Http.StreamingCallback = shared query func(_ : Http.StreamingToken) : async Http.StreamingCallbackResponse {
  { body = ""; token = null };
};

func upload(s : Wasm.Store, chunks : [Blob], size : Nat) : Bool {
  Wasm.begin(s);
  for (ch in chunks.values()) Wasm.append(s, ch);
  Wasm.commit(s, size);
};

// ── 1. Nothing uploaded: 404, size 0 ───────────────────────────────────────
do {
  let s = Wasm.new();
  let r = Wasm.respond(s, callback);
  if (r.status_code != 404) Runtime.trap("1a: empty store must answer 404, got " # debug_show (r.status_code));
  if (Wasm.size(s) != 0) Runtime.trap("1b: empty store has size 0");
  if (Wasm.stream(s, { index = 0 }).token != null) Runtime.trap("1c: streaming an empty store ends at once");
  Debug.print("1. empty store OK");
};

// ── 2. A committed upload is served: first chunk inline, the rest streamed ─
do {
  let s = Wasm.new();
  if (not upload(s, [a, b, c], 6)) Runtime.trap("2a: a complete upload commits");
  if (Wasm.size(s) != 6) Runtime.trap("2b: size adds the chunks up");
  let r = Wasm.respond(s, callback);
  if (r.status_code != 200 or r.body != a) Runtime.trap("2c: the first chunk is the body");
  if (r.headers != [("content-type", "application/wasm")]) Runtime.trap("2d: served as application/wasm");
  switch (r.streaming_strategy) {
    case (?#Callback({ token })) if (token.index != 1) Runtime.trap("2e: streaming resumes at chunk 1");
    case null Runtime.trap("2f: more than one chunk needs a streaming strategy");
  };
  let s1 = Wasm.stream(s, { index = 1 });
  if (s1.body != b or s1.token != ?{ index = 2 }) Runtime.trap("2g: chunk 1 points at chunk 2");
  let s2 = Wasm.stream(s, { index = 2 });
  if (s2.body != c or s2.token != null) Runtime.trap("2h: the last chunk ends the stream");
  if (Wasm.stream(s, { index = 3 }).body != Blob.fromArray([])) Runtime.trap("2i: past the end is empty");
  Debug.print("2. upload served and streamed OK");
};

// ── 3. A single chunk streams nothing ──────────────────────────────────────
do {
  let s = Wasm.new();
  ignore upload(s, [a], 3);
  if (Wasm.respond(s, callback).streaming_strategy != null) Runtime.trap("3a: one chunk needs no stream");
  Debug.print("3. single chunk OK");
};

// ── 4. A size mismatch keeps the previous module; `begin` restarts ─────────
do {
  let s = Wasm.new();
  ignore upload(s, [a, b, c], 6);
  if (upload(s, [a], 6)) Runtime.trap("4a: short upload must not commit");
  if (Wasm.size(s) != 6 or Wasm.respond(s, callback).body != a) Runtime.trap("4b: previous module kept");
  if (upload(s, [], 0)) Runtime.trap("4c: an empty upload must not commit");
  Wasm.begin(s);
  Wasm.append(s, c);
  Wasm.begin(s);
  if (not upload(s, [b], 2)) Runtime.trap("4d: begin discards earlier staged chunks");
  if (Wasm.size(s) != 2) Runtime.trap("4e: the restarted upload replaced the module");
  Debug.print("4. mismatch and restart OK");
};

Debug.print("ALL WASM CHECKS PASSED");
