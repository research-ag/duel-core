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
  ClientKey: IDLNS.Type;
  WsResult: IDLNS.Type;
  CanisterWsOpenArguments: IDLNS.Type;
  CanisterWsCloseArguments: IDLNS.Type;
  WebsocketMessage: IDLNS.Type;
  CanisterWsMessageArguments: IDLNS.Type;
  CanisterWsGetMessagesArguments: IDLNS.Type;
  CanisterOutputMessage: IDLNS.Type;
  CanisterOutputCertifiedMessages: IDLNS.Type;
  CanisterWsGetMessagesResult: IDLNS.Type;
  WebsocketServiceMessageContent: IDLNS.Type;
  WsRequest: IDLNS.Type;
  WsMsg: IDLNS.Type;
}

/// Every named Candid type the service surface uses — `status`'s types
/// plus the WS protocol's, including `WebsocketServiceMessageContent`,
/// which only `ws/gateway-protocol.ts` encodes. Exported so the protocol
/// layer encodes against the exact same descriptions.
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
  // wire, via a `#view` push.
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
      secondsUntilReclaimable: IDL.Nat,
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

  // Fixed `ic-websocket-cdk` shapes.
  const ClientKey = IDL.Record({
    client_principal: IDL.Principal,
    client_nonce: IDL.Nat64,
  });
  const WsResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const CanisterWsOpenArguments = IDL.Record({
    client_nonce: IDL.Nat64,
    gateway_principal: IDL.Principal,
  });
  const CanisterWsCloseArguments = IDL.Record({ client_key: ClientKey });
  const WebsocketMessage = IDL.Record({
    client_key: ClientKey,
    sequence_num: IDL.Nat64,
    timestamp: IDL.Nat64,
    is_service_message: IDL.Bool,
    content: IDL.Vec(IDL.Nat8),
  });
  const CanisterWsMessageArguments = IDL.Record({ msg: WebsocketMessage });
  const CanisterWsGetMessagesArguments = IDL.Record({ nonce: IDL.Nat64 });
  const CanisterOutputMessage = IDL.Record({
    client_key: ClientKey,
    key: IDL.Text,
    content: IDL.Vec(IDL.Nat8),
  });
  const CanisterOutputCertifiedMessages = IDL.Record({
    messages: IDL.Vec(CanisterOutputMessage),
    cert: IDL.Vec(IDL.Nat8),
    tree: IDL.Vec(IDL.Nat8),
    is_end_of_queue: IDL.Bool,
  });
  const CanisterWsGetMessagesResult = IDL.Variant({
    Ok: CanisterOutputCertifiedMessages,
    Err: IDL.Text,
  });

  // The CDK's service-message envelope inside `content` when
  // `is_service_message` is true (`Types.WebsocketServiceMessageContent`).
  const CloseMessageReason = IDL.Variant({
    WrongSequenceNumber: IDL.Null,
    InvalidServiceMessage: IDL.Null,
    KeepAliveTimeout: IDL.Null,
    ClosedByApplication: IDL.Null,
  });
  const WebsocketServiceMessageContent = IDL.Variant({
    OpenMessage: IDL.Record({ client_key: ClientKey }),
    AckMessage: IDL.Record({ last_incoming_sequence_num: IDL.Nat64 }),
    KeepAliveMessage: IDL.Record({ last_incoming_sequence_num: IDL.Nat64 }),
    CloseMessage: IDL.Record({ reason: CloseMessageReason }),
  });

  // Mirrors `Ws.Msg<S, M>`. `reqId` is echoed back only on the acting
  // session's own reply; a push to anyone else carries `null`.
  const WsRequest = IDL.Variant({
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
  const WsMsg = IDL.Variant({
    req: IDL.Record({ sid: IDL.Text, req: WsRequest, reqId: IDL.Opt(IDL.Nat64) }),
    view: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), view: Status }),
    err: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), err: Err }),
  });

  return {
    Seat, Mode, Verdict, End, Err, View, TableId, Visibility, TableSummary, Status,
    LeaderboardEntry, BotInfo,
    ClientKey, WsResult, CanisterWsOpenArguments, CanisterWsCloseArguments,
    WebsocketMessage, CanisterWsMessageArguments,
    CanisterWsGetMessagesArguments, CanisterOutputMessage,
    CanisterOutputCertifiedMessages, CanisterWsGetMessagesResult,
    WebsocketServiceMessageContent, WsRequest, WsMsg,
  };
}

/// Wraps a game's `{ Action, State }` in the fixed service shape. No
/// mutating methods: mutation goes exclusively through `ws_message`.
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
      ws_open: IDL.Func([t.CanisterWsOpenArguments], [t.WsResult], []),
      ws_close: IDL.Func([t.CanisterWsCloseArguments], [t.WsResult], []),
      // The second parameter is a plain `opt blob` the canister ignores;
      // `content` inside `msg` carries the real message.
      ws_message: IDL.Func(
        [t.CanisterWsMessageArguments, IDL.Opt(IDL.Vec(IDL.Nat8))],
        [t.WsResult],
        [],
      ),
      ws_get_messages: IDL.Func(
        [t.CanisterWsGetMessagesArguments],
        [t.CanisterWsGetMessagesResult],
        ["query"],
      ),
    });
  };
}

/// An `idlFactory` for a discovered bot's own `play(host, tableId, seat,
/// code, complexity)`, called directly on the bot's canister (never through
/// `ws.mo`). Reuses `buildEngineTypes` for `Seat`/`TableId`/`Err`.
export function buildBotPlayIdlFactory({ IDL }: { IDL: typeof IDLNS }) {
  const t = buildEngineTypes({ IDL, Action: IDL.Null, State: IDL.Null });
  const JoinOk = IDL.Variant({ staged: t.Seat, started: t.Seat });
  const Res = IDL.Variant({ ok: JoinOk, err: t.Err });
  return IDL.Service({
    play: IDL.Func([IDL.Principal, t.TableId, t.Seat, IDL.Opt(IDL.Text), IDL.Text], [Res], []),
  });
}
