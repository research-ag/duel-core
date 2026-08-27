// Generic Candid interface factory for any TwoPlayer-engine-backed
// canister. Every type here except `Action`/`State` is fixed by the
// engine (TwoPlayer.mo) — a game only supplies those two.
//
// Usage:
//
//   import { makeIdlFactory } from "duel-game-core/idl.js";
//   import { Actor, HttpAgent } from "@dfinity/agent";
//
//   const idlFactory = makeIdlFactory(({ IDL }) => ({
//     Action: IDL.Variant({ /* your move shape */ }),
//     State: IDL.Record({ /* your game state shape */ }),
//   }));
//   const actor = Actor.createActor(idlFactory, { agent, canisterId });
//
// `buildGameTypes` receives the same `{ IDL }` the Candid tooling passes
// to an `idlFactory`, so it can build `Action`/`State` out of any other
// IDL type it needs (records, nested variants, vecs, ...).

/// Wraps a game's `{ Action, State }` Candid types in the fixed
/// TwoPlayer service shape and returns a ready-to-use `idlFactory`.
export function makeIdlFactory(buildGameTypes) {
  return ({ IDL }) => {
    const { Action, State } = buildGameTypes({ IDL });

    const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
    const Verdict = IDL.Variant({
      p1Wins: IDL.Null,
      p2Wins: IDL.Null,
      draw: IDL.Null,
    });
    const End = IDL.Variant({ finished: Verdict, aborted: Seat });
    const Err = IDL.Variant({
      seatTaken: IDL.Null,
      notSeated: IDL.Null,
      alreadySubmitted: IDL.Null,
      illegalMove: IDL.Text,
      wrongPhase: IDL.Text,
      reserved: IDL.Record({ secondsLeft: IDL.Nat }),
      notIdle: IDL.Record({ secondsLeft: IDL.Nat }),
    });
    const JoinOk = IDL.Variant({ staged: Seat, started: Seat });
    const SubmitOk = IDL.Variant({
      waiting: IDL.Null,
      roundResolved: IDL.Nat,
      gameEnded: IDL.Record({ verdict: Verdict, turns: IDL.Nat }),
    });
    const RematchOk = IDL.Variant({
      awaitingPartner: IDL.Null,
      started: IDL.Null,
    });
    const View = IDL.Variant({
      lobby: IDL.Record({
        p1Open: IDL.Bool,
        p2Open: IDL.Bool,
        resetAvailable: IDL.Bool,
      }),
      busy: IDL.Record({ secondsUntilTakeover: IDL.Nat }),
      stagingYou: IDL.Record({ seat: Seat, reservedForPartner: IDL.Bool }),
      awaitingRematch: IDL.Record({ openSeat: Seat }),
      inGame: IDL.Record({
        seat: Seat,
        game: State,
        turn: IDL.Nat,
        youSubmitted: IDL.Bool,
        oppSubmitted: IDL.Bool,
      }),
      debrief: IDL.Record({
        seat: Seat,
        end: End,
        turns: IDL.Nat,
        finalGame: State,
      }),
      endedByOther: IDL.Null,
    });

    return IDL.Service({
      join: IDL.Func(
        [IDL.Text, Seat],
        [IDL.Variant({ ok: JoinOk, err: Err })],
        [],
      ),
      submit: IDL.Func(
        [IDL.Text, Action],
        [IDL.Variant({ ok: SubmitOk, err: Err })],
        [],
      ),
      rematch: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: RematchOk, err: Err })],
        [],
      ),
      leave: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: IDL.Null, err: Err })],
        [],
      ),
      reset: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: IDL.Null, err: Err })],
        [],
      ),
      ackEnded: IDL.Func([IDL.Text], [], []),
      status: IDL.Func([IDL.Text], [View], ["query"]),
    });
  };
}
