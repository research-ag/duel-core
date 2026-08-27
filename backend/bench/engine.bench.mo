/// Benchmarks the engine's own overhead — the bookkeeping it does around
/// a game's `Spec` calls — using `FakeGame.mo` (see `test/FakeGame.mo`)
/// as the plugged-in `Spec`, since a real game's `resolve` cost would
/// otherwise swamp the numbers this is meant to isolate.
import Bench "mo:bench-helper";
import TP "../src/lib";
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
    let ns : [Nat] = [10, 100, 1000];

    func freshGame() : TP.Table<Rules.State, Rules.Action> {
      let t = TP.create<Rules.State, Rules.Action>(timeout);
      ignore TP.join(spec, t, 0, "a", #p1);
      ignore TP.join(spec, t, 0, "b", #p2);
      t;
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
            let t = TP.create<Rules.State, Rules.Action>(timeout);
            ignore TP.join(spec, t, 0, "a", #p1);
            ignore TP.leave(t, 0, "a");
            i += 1;
          };
        };
        // One live game, N completed rounds (both players GATHER, which
        // never ends the game — see FakeGame.mo). Isolates the cost of
        // `submit`'s pending-move bookkeeping and round resolution.
        case (1) {
          let t = freshGame();
          while (i < n) {
            ignore TP.submit(spec, t, 0, "a", #gather);
            ignore TP.submit(spec, t, 0, "b", #gather);
            i += 1;
          };
        };
        // One live game, N `status` queries. Isolates the read path a
        // polling frontend hammers continuously — must stay cheap and
        // side-effect-free (CLAUDE.md rule 8).
        case (2) {
          let t = freshGame();
          while (i < n) {
            ignore TP.status(t, 0, "a");
            i += 1;
          };
        };
        case (_) {};
      };
    };

    Bench.V1(schema, run);
  };
};
