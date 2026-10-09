// Candid interface factory for any duel-game-core canister. Every type
// except the game's `Action`/`View`/`Options` is fixed by the engine.
// `IDL` always arrives as a parameter from the caller's own Candid tooling.
//
//   const idlFactory = makeIdlFactory(({ IDL }) => ({
//     Action: IDL.Variant({ /* ... */ }),
//     View: IDL.Record({ /* ... */ }),     // what one seat sees of the state
//     Options: IDL.Record({}),             // a table's options
//   }));
//   const actor = Actor.createActor(idlFactory, { agent, canisterId });

import type { IDL as IDLNS } from "@icp-sdk/core/candid";

export type BuildGameTypes = (args: { IDL: typeof IDLNS }) => {
  Action: IDLNS.Type;
  View: IDLNS.Type;
  Options: IDLNS.Type;
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
  TransportRequest: IDLNS.Type;
  TransportReply: IDLNS.Type;
  Ack: IDLNS.Type;
  TableResult: IDLNS.Type;
  LobbyResult: IDLNS.Type;
  KeepAliveResult: IDLNS.Type;
}

/// Every named Candid type the service surface uses, plus `Status`, the
/// shape `DuelTransport` composes for a client. Exported so `transport.ts` encodes against the
/// exact same descriptions.
export function buildEngineTypes({
  IDL,
  Action,
  View: GameView,
  Options,
}: {
  IDL: typeof IDLNS;
  Action: IDLNS.Type;
  View: IDLNS.Type;
  Options: IDLNS.Type;
}): EngineTypes {
  const Seat = IDL.Variant({ p1: IDL.Null, p2: IDL.Null });
  const Mode = IDL.Variant({ simultaneous: IDL.Null, turnBased: IDL.Null });
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
    tooManyTables: IDL.Record({ max: IDL.Nat }),
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
      game: GameView,
      step: IDL.Nat,
      mode: Mode,
      toMove: IDL.Opt(Seat),
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
      steps: IDL.Nat,
      finalGame: GameView,
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
    options: Options,
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

  // The client's own request vocabulary (`DuelTransport` maps each case
  // to its method); never sent as such, only used to reject a malformed
  // request before it is queued.
  const TransportRequest = IDL.Variant({
    createTable: IDL.Record({ seat: Seat, visibility: Visibility, options: Options }),
    joinTable: IDL.Record({ id: TableId, seat: Seat, code: IDL.Opt(IDL.Text) }),
    submit: IDL.Record({ gen: IDL.Nat, step: IDL.Nat, move: Action }),
    rematch: IDL.Null,
    leave: IDL.Record({ gen: IDL.Nat }),
    reset: IDL.Record({ gen: IDL.Nat }),
    claimWin: IDL.Record({ gen: IDL.Nat }),
    ackEnded: IDL.Null,
    status: IDL.Null,
  });
  // Mirrors `Transport.Snapshot<S>`/`Reply<S>`/`TableResult<S>`/
  // `LobbyResult`/`Ack`: `rev` orders one table's (or the lobby's) views.
  const Snapshot = IDL.Record({ rev: IDL.Nat, view: View });
  const TransportReply = IDL.Variant({ view: Snapshot, err: Err });
  const TableResult = IDL.Variant({
    unchanged: IDL.Null,
    changed: Snapshot,
    gone: IDL.Null,
  });
  const LobbyResult = IDL.Variant({
    unchanged: IDL.Null,
    changed: IDL.Record({ rev: IDL.Nat, tables: IDL.Vec(TableSummary), yours: IDL.Vec(TableId) }),
  });
  const Ack = IDL.Variant({ ok: IDL.Record({ tableId: TableId, rev: IDL.Nat }), err: Err });
  const KeepAliveResult = IDL.Variant({ ok: IDL.Null, err: Err });

  return {
    Seat, Mode, Verdict, End, Err, View, TableId, Visibility, TableSummary, Status,
    LeaderboardEntry, BotInfo,
    TransportRequest, TransportReply, Ack, TableResult, LobbyResult, KeepAliveResult,
  };
}

/// Wraps a game's `{ Action, View, Options }` in the fixed service shape. Game
/// state is mutated only through the `duel_*` transport methods.
/// `get_leaderboard`/`register_bot`/`unregister_bot`/`list_bots` are
/// declared unconditionally; a client that never calls them pays nothing.
export function makeIdlFactory(buildGameTypes: BuildGameTypes) {
  return ({ IDL }: { IDL: typeof IDLNS }) => {
    const { Action, View, Options } = buildGameTypes({ IDL });
    const t = buildEngineTypes({ IDL, Action, View, Options });

    return IDL.Service({
      get_leaderboard: IDL.Func([], [IDL.Vec(t.LeaderboardEntry)], ["query"]),
      register_bot: IDL.Func([IDL.Text, IDL.Vec(IDL.Text)], [], []),
      unregister_bot: IDL.Func([], [], []),
      list_bots: IDL.Func([], [IDL.Vec(t.BotInfo)], ["query"]),
      duel_create_table: IDL.Func([t.Seat, t.Visibility, Options], [t.Ack], []),
      duel_join_table: IDL.Func([t.TableId, t.Seat, IDL.Opt(IDL.Text)], [t.Ack], []),
      duel_rematch: IDL.Func([t.TableId], [t.Ack], []),
      duel_leave: IDL.Func([t.TableId, IDL.Nat], [t.Ack], []),
      duel_reset: IDL.Func([t.TableId, IDL.Nat], [t.Ack], []),
      duel_claim_win: IDL.Func([t.TableId, IDL.Nat], [t.Ack], []),
      duel_ack_ended: IDL.Func([t.TableId], [t.Ack], []),
      duel_keep_alive: IDL.Func([], [t.KeepAliveResult], []),
      duel_submit: IDL.Func([t.TableId, IDL.Nat, IDL.Nat, Action], [t.TransportReply], []),
      duel_lobby: IDL.Func([IDL.Nat], [t.LobbyResult], ["query"]),
      duel_table: IDL.Func([t.TableId, IDL.Nat], [t.TableResult], ["query"]),
    });
  };
}

/// An `idlFactory` for a discovered bot's own `play(host, tableId, seat,
/// code, complexity)`, called directly on the bot's canister (never through
/// `transport.mo`). Reuses `buildEngineTypes` for `Seat`/`TableId`/`Err`.
export function buildBotPlayIdlFactory({ IDL }: { IDL: typeof IDLNS }) {
  const t = buildEngineTypes({ IDL, Action: IDL.Null, View: IDL.Null, Options: IDL.Null });
  const JoinOk = IDL.Variant({ staged: t.Seat, started: t.Seat });
  const Res = IDL.Variant({ ok: JoinOk, err: t.Err });
  return IDL.Service({
    play: IDL.Func([IDL.Principal, t.TableId, t.Seat, IDL.Opt(IDL.Text), IDL.Text], [Res], []),
  });
}
