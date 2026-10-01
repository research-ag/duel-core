/// Benchmarks the engine's own overhead, using FakeGame.mo as the `Spec`.
import Bench "mo:bench-helper";
import Runtime "mo:core/Runtime";

import TP "../src/lib";
import Registry "../src/registry";
import Table "../src/table";

import Rules "../test/FakeGame";

module {
  public func init() : Bench.V1 {
    let schema : Bench.Schema = {
      name = "TwoPlayer engine overhead";
      description = "Cost of the engine's core operations, scaled by how many times each runs";
      rows = ["join+leave (fresh table each time)", "one round (both submit)", "status (in-game, side-effect-free)"];
      cols = ["10", "100", "1000"];
    };

    let spec = Rules.spec();
    let timeout : Int = 60_000_000_000;
    let reg = Registry.new<Rules.State, Rules.Action>();
    reg.setTimeouts(timeout, timeout);
    let ns : [Nat] = [10, 100, 1000];

    func freshGame() : () {
      let tid = switch (reg.createTable(spec, 0, "a", #p1, #open, "")) {
        case (#ok id) { id };
        case (#err e) Runtime.trap("freshGame: createTable failed: " # debug_show (e));
      };
      ignore reg.joinTable(spec, 0, "b", tid, #p2, null);
    };

    let run : Bench.Runner = func(ri, ci) {
      let n = ns[ci];
      var i = 0;
      switch (ri) {
        // Seat + immediately vacate a fresh table, N times. Isolates the
        // cost of standing up a match and tearing it down again — the
        // path every lobby click and quick disconnect takes.
        case (0) {
          while (i < n) {
            switch (reg.createTable(spec, 0, "c", #p1, #open, "")) {
              case (#ok _) {};
              case (#err e) Runtime.trap("createTable failed: " # debug_show (e));
            };
            ignore reg.leave(0, "c", 1);
            i += 1;
          };
        };
        // One live game, N completed rounds (both players GATHER, which
        // never ends the game — see FakeGame.mo). Isolates the cost of
        // `submit`'s pending-move bookkeeping and round resolution.
        case (1) {
          freshGame();
          while (i < n) {
            // `gen` is a fixed `1` for this game's whole lifetime (no
            // rematch ever happens here); `turn` is `i` for both calls in
            // this round — it only advances once BOTH have submitted.
            ignore reg.submit(spec, 0, "a", 1, i, #gather);
            ignore reg.submit(spec, 0, "b", 1, i, #gather);
            i += 1;
          };
          // FakeGame's #gather never ends the match, so the table is still
          // #active here
          ignore reg.leave(0, "a", 1);
          ignore reg.leave(0, "b", 1);
          ignore reg.leave(0, "a", 1);
        };
        // One live game, N `status` queries.
        case (2) {
          freshGame();
          while (i < n) {
            ignore reg.status(spec, 0, "a");
            i += 1;
          };
          // Same abort/ack asymmetry as case (1) above — "a" must leave
          // twice to fully free itself from the still-#active table.
          ignore reg.leave(0, "a", 1);
          ignore reg.leave(0, "b", 1);
          ignore reg.leave(0, "a", 1);
        };
        case (_) {};
      };
    };

    Bench.V1(schema, run);
  };
};
