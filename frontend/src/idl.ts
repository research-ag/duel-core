// Candid interface factory for any duel-game-core canister. Every type
// except `Action`/`State` is fixed by the engine. `IDL` always arrives as
// a parameter from the caller's own Candid tooling.
//
//   const idlFactory = makeIdlFactory(({ IDL }) => ({
//     Action: IDL.Variant({ /* ... */ }),
//     State: IDL.Record({ /* ... */ }),
//   }));
//   const actor = Actor.createActor(idlFactory, { agent, canisterId });

import type { IDL as IDLNS } from "@icp-sdk/core/candid";

export type BuildGameTypes = (args: { IDL: typeof IDLNS }) => {
  Action: IDLNS.Type;
  State: IDLNS.Type;
};

export interface EngineTypes {
  Seat: IDLNS.Type;
  Mode: IDLNS.Type;
  Verdict: IDLNS.Type;
  End: IDLNS.Type;
  Err: IDLNS.Type;
  View: IDLNS.Type;
  TableId: IDLNS.Type;
  Visibility: IDLNS.Type;
  TableSummary: IDLNS.Type;
  Status: IDLNS.Type;
  LeaderboardEntry: IDLNS.Type;
  BotInfo: IDLNS.Type;
  PollResult: IDLNS.Type;
  TransportRequest: IDLNS.Type;
  TransportMsg: IDLNS.Type;
}

/// Every named Candid type the service surface uses — `status`'s types
/// plus the transport's. Exported so `transport.ts` encodes against the
/// exact same descriptions.
export function buildEngineTypes({
  IDL,
  Action,
  State,
}: {
  IDL: typeof IDLNS;
  Action: IDLNS.Type;
  State: IDLNS.Type;
}): EngineTypes {
  const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
  const Mode = IDL.Variant({ simultaneous: IDL.Null, alternating: IDL.Null });
  const Verdict = IDL.Variant({
    p1Wins: IDL.Null,
    p2Wins: IDL.Null,
    draw: IDL.Null,
  });
  const End = IDL.Variant({ finished: Verdict, aborted: Seat, claimed: Seat });
  const Err = IDL.Variant({
    seatTaken: IDL.Null,
    notSeated: IDL.Null,
    alreadySubmitted: IDL.Null,
    notYourTurn: IDL.Null,
    illegalMove: IDL.Text,
    wrongPhase: IDL.Text,
    reserved: IDL.Record({ secondsLeft: IDL.Nat }),
    notIdle: IDL.Record({ secondsLeft: IDL.Nat }),
    notOverdue: IDL.Record({ secondsLeft: IDL.Nat }),
    stale: IDL.Null,
    noSuchTable: IDL.Null,
    badCode: IDL.Null,
    unauthorized: IDL.Null,
  });
  // No JoinOk/SubmitOk/RematchOk: only a fresh `View` ever crosses the
  // wire, in a `#view`.
  const Visibility = IDL.Variant({ open: IDL.Null, code: IDL.Text });
  const View = IDL.Variant({
    lobby: IDL.Record({
      p1Open: IDL.Bool,
      p2Open: IDL.Bool,
      resetAvailable: IDL.Bool,
    }),
    busy: IDL.Record({ secondsUntilTakeover: IDL.Nat }),
    stagingYou: IDL.Record({
      seat: Seat,
      reservedForPartner: IDL.Bool,
      gen: IDL.Nat,
      visibility: Visibility,
    }),
    awaitingRematch: IDL.Record({ openSeat: Seat, gen: IDL.Nat }),
    inGame: IDL.Record({
      seat: Seat,
      game: State,
      turn: IDL.Nat,
      mode: Mode,
      youSubmitted: IDL.Bool,
      oppSubmitted: IDL.Bool,
      gen: IDL.Nat,
      secondsUntilIdleReset: IDL.Nat,
      idleTimeoutSecs: IDL.Nat,
      claimWinAvailable: IDL.Bool,
      secondsUntilClaimable: IDL.Nat,
      claimTimeoutSecs: IDL.Nat,
    }),
    debrief: IDL.Record({
      seat: Seat,
      end: End,
      turns: IDL.Nat,
      finalGame: State,
      gen: IDL.Nat,
    }),
    endedByOther: IDL.Null,
  });

  const TableId = IDL.Nat;
  const TableSummary = IDL.Record({
    id: TableId,
    p1Open: IDL.Bool,
    p2Open: IDL.Bool,
    p1Session: IDL.Opt(IDL.Text),
    p2Session: IDL.Opt(IDL.Text),
    protected: IDL.Bool,
    waitingSecs: IDL.Nat,
    variant: IDL.Text,
  });
  const Status = IDL.Variant({
    browsing: IDL.Record({ tables: IDL.Vec(TableSummary) }),
    atTable: IDL.Record({ id: TableId, view: View }),
  });

  // Mirrors `Leaderboard.Entry` (`Int` -> `IDL.Int` -> bigint).
  const LeaderboardEntry = IDL.Record({
    player: IDL.Text,
    score: IDL.Int,
    updatedAt: IDL.Int,
  });

  // Mirrors `CanisterPlayers.BotEntry`/`BotComplexityEntry`.
  const BotComplexity = IDL.Record({
    complexity: IDL.Text,
    elo: IDL.Opt(IDL.Int),
  });
  const BotInfo = IDL.Record({
    principal: IDL.Principal,
    name: IDL.Text,
    complexities: IDL.Vec(BotComplexity),
  });

  // Mirrors `Transport.Msg<S, M>`: `rev` orders views.
  const TransportRequest = IDL.Variant({
    createTable: IDL.Record({ seat: Seat, visibility: Visibility, variant: IDL.Text }),
    joinTable: IDL.Record({ id: TableId, seat: Seat, code: IDL.Opt(IDL.Text) }),
    submit: IDL.Record({ gen: IDL.Nat, turn: IDL.Nat, move: Action }),
    rematch: IDL.Null,
    leave: IDL.Record({ gen: IDL.Nat }),
    reset: IDL.Record({ gen: IDL.Nat }),
    claimWin: IDL.Record({ gen: IDL.Nat }),
    ackEnded: IDL.Null,
    status: IDL.Null,
  });
  const TransportMsg = IDL.Variant({
    req: IDL.Record({ sid: IDL.Text, req: TransportRequest }),
    view: IDL.Record({ rev: IDL.Nat, view: Status }),
    err: IDL.Record({ err: Err }),
  });
  // `changed` carries an encoded `TransportMsg` `#view`.
  const PollResult = IDL.Variant({
    unchanged: IDL.Null,
    changed: IDL.Vec(IDL.Nat8),
    unknown: IDL.Null,
  });

  return {
    Seat, Mode, Verdict, End, Err, View, TableId, Visibility, TableSummary, Status,
    LeaderboardEntry, BotInfo,
    PollResult, TransportRequest, TransportMsg,
  };
}

/// Wraps a game's `{ Action, State }` in the fixed service shape. No
/// mutating methods: mutation goes exclusively through `duel_request`.
/// `get_leaderboard`/`register_bot`/`unregister_bot`/`list_bots` are
/// declared unconditionally; a client that never calls them pays nothing.
export function makeIdlFactory(buildGameTypes: BuildGameTypes) {
  return ({ IDL }: { IDL: typeof IDLNS }) => {
    const { Action, State } = buildGameTypes({ IDL });
    const t = buildEngineTypes({ IDL, Action, State });

    return IDL.Service({
      status: IDL.Func([IDL.Text], [t.Status], ["query"]),
      get_leaderboard: IDL.Func([], [IDL.Vec(t.LeaderboardEntry)], ["query"]),
      register_bot: IDL.Func([IDL.Text, IDL.Vec(IDL.Text)], [], []),
      unregister_bot: IDL.Func([], [], []),
      list_bots: IDL.Func([], [IDL.Vec(t.BotInfo)], ["query"]),
      // Both blobs are an encoded `TransportMsg`.
      duel_request: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Vec(IDL.Nat8)], []),
      duel_poll: IDL.Func([IDL.Text, IDL.Nat], [t.PollResult], ["query"]),
    });
  };
}

/// An `idlFactory` for a discovered bot's own `play(host, tableId, seat,
/// code, complexity)`, called directly on the bot's canister (never through
/// `transport.mo`). Reuses `buildEngineTypes` for `Seat`/`TableId`/`Err`.
export function buildBotPlayIdlFactory({ IDL }: { IDL: typeof IDLNS }) {
  const t = buildEngineTypes({ IDL, Action: IDL.Null, State: IDL.Null });
  const JoinOk = IDL.Variant({ staged: t.Seat, started: t.Seat });
  const Res = IDL.Variant({ ok: JoinOk, err: t.Err });
  return IDL.Service({
    play: IDL.Func([IDL.Principal, t.TableId, t.Seat, IDL.Opt(IDL.Text), IDL.Text], [Res], []),
  });
}
