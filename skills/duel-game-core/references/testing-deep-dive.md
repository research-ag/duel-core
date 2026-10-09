# Testing a game that takes many rounds to finish

Read this when the win condition takes dozens or hundreds of rounds to
reach (a long race, a tournament), especially if `resolve` does real
per-round work. Ordinary `RulesUnit.test.mo` tests (build a `State` by
hand, call `validate`/`resolve`) are unaffected; this is about reaching a
genuine `#debrief` through the real engine in a lifecycle-style test.

## The trap

- `moc -r` is slow, and its cost is whatever `resolve` does per round:
  a collision check against an 875-point polygon every round costs tens
  of seconds over a couple hundred rounds.
- A hand-written autopilot can get stuck (a crash loop, oscillating
  between two states) and only a timeout rescues you, burning minutes per
  attempt while you debug the bot instead of the game.

## The fix: seed the state, then submit one real move

`Table<S, M, O>.phase` is a public `var`. Join two real sessions normally,
then overwrite just the `game : S` payload of the live `#active` phase
with a state one legal move from finishing:

```motoko
public func seedGame(t : TP.Table<R.State, R.Action, R.Options>, p1 : R.CarState, p2 : R.CarState) {
  switch (t.phase) {
    case (#active a) t.phase := #active({
      a with game = { p1; p2; step = a.game.step }
    });
    case (_) Runtime.trap("seedGame: table is not #active");
  };
};

```

Then submit ONE real move and let the real `resolve`/verdict/phase
transition run. Milliseconds, fully reliable, no autopilot needed. See
`examples/racing/test/RaceTestHelpers.mo` in the framework repo, which
derives the seeded coordinates from the real track data.

Don't write a simulated playthrough or a lookahead bot for this; both
multiply the interpreter cost.

## Everything that isn't "reach a finished game"

Physics bounds, penalty rules, unreachable edge cases: construct
synthetic `State` values and call `validate`/`resolve` (or `move`)
directly. That is
better test design, not a compromise.
