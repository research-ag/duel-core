# Testing a game that takes many rounds to finish

Read this when your game's win condition takes dozens or hundreds of
real rounds to reach (a long race, a multi-round tournament, anything
that isn't naturally over in a handful of moves) — especially if
`resolve` does nontrivial per-round work (a geometry/collision check, a
scan over a large board). `RulesUnit.test.mo`'s ordinary synthetic-state
tests (construct a `State` by hand, call `validate`/`resolve` directly —
see the main `SKILL.md`) stay exactly as easy regardless of round count;
this file is specifically about the harder case of reaching a genuine
`#debrief` through the real engine for a scenario/lifecycle-style test.

## The trap

Driving a full, real game through the engine round by round — the way a
short duel's own test suite might reach its ending — goes wrong two ways
at once for a long game:

- **`moc -r` (the interpreter `mops test` runs under) is slow**, and its
  cost is dominated by whatever `resolve()` does per round. A
  boundary-collision check against an 875-point polygon, run every
  round, can cost tens of seconds over a couple hundred rounds — and
  that's the SAME cost regardless of how many rounds you split it into,
  since it scales with total distance/work done, not round count.
- **A hand-written "AI" driving realistic input can get stuck** in a
  local minimum (a crash loop at one particular spot, oscillating
  between the same two states forever) that no round-cap rescues you
  from except by timing out — burning real wall-clock minutes per
  attempt while you debug a bot, not the game.

## The fix: seed the state directly, then submit one real move

`Table<S, M>.phase` is a **public `var` field**. A test can join two
real sessions normally (so the engine's own seat/turn/timestamp
bookkeeping is genuine), then reach in and overwrite just the `game : S`
payload of the live `#active` phase with a state that's one legal move
from finishing:

```motoko
public func seedGame(t : TP.Table<R.State, R.Action>, p1 : R.CarState, p2 : R.CarState) {
  switch (t.phase) {
    case (#active a) {
      t.phase := #active({ a with game = { p1; p2; step = a.game.step } });
    };
    case (_) Runtime.trap("seedGame: table is not #active");
  };
};

```

Then submit ONE real move through the actual `TP.submit` and let the
real `resolve`/verdict/phase-transition machinery run for real. This
gives a genuine, fast (milliseconds, not tens of seconds), 100% reliable
test of the engine integration, without needing a working "autopilot" at
all. See
[`examples/racing/test/RaceTestHelpers.mo`](https://github.com/research-ag/duel-core/blob/main/examples/racing/test/RaceTestHelpers.mo)
in the framework's own repo for a complete implementation of this
pattern (deriving the exact synthetic coordinates from the real
track/road data, not guessed numbers).

Don't reach for a from-scratch simulated playthrough, and don't reach
for a 1-step-lookahead search-over-candidate-moves bot either —
multiplying the per-round interpreter cost by every candidate you
evaluate makes a slow suite even slower. State-seeding is both simpler
and faster than either.

## Everything that ISN'T "reach a finished game"

Physics bounds, penalty rules, edge cases ordinary play can't reach —
construct synthetic `State` values directly and call
`validate`/`resolve` without going through the engine at all, exactly as
the main `SKILL.md`'s `RulesUnit.test.mo` guidance already describes.
This isn't a compromise for speed — it's better test design: a targeted
edge case instead of hoping realistic play happens to hit it.
