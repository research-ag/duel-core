// Generic Candid interface factory for any TwoPlayer-engine-backed
// canister. Every type here except `Action`/`State` is fixed by the
// engine (TwoPlayer.mo) — a game only supplies those two.
//
// Usage:
//
//   import { makeIdlFactory } from "duel-game-core/idl.js";
//   import { Actor, HttpAgent } from "@icp-sdk/core/agent";
//
//   const idlFactory = makeIdlFactory(({ IDL }) => ({
//     Action: IDL.Variant({ /* your move shape */ }),
//     State: IDL.Record({ /* your game state shape */ }),
//   }));
//   const actor = Actor.createActor(idlFactory, { agent, canisterId });
//
// `buildGameTypes` receives the same `{ IDL }` the Candid tooling passes
// to an `idlFactory`, so it can build `Action`/`State` out of any other
// IDL type it needs (records, nested variants, vecs, ...). This module
// never imports an IDL implementation itself — `IDL` always arrives as a
// parameter from the caller's own Candid tooling, so it works against
// any implementation whose `IDL` namespace is structurally compatible
// with `@icp-sdk/core/candid`'s, whichever built the `idlFactory` in the
// first place.

import type { IDL as IDLNS } from "@icp-sdk/core/candid";

export type BuildGameTypes = (args: { IDL: typeof IDLNS }) => {
  Action: IDLNS.Type;
  State: IDLNS.Type;
};

/// Every named Candid type this package's service surface uses, keyed by
/// name — see the return type below for the full list.
export interface EngineTypes {
  Seat: IDLNS.Type;
  Verdict: IDLNS.Type;
  End: IDLNS.Type;
  Err: IDLNS.Type;
  View: IDLNS.Type;
  TableId: IDLNS.Type;
  Visibility: IDLNS.Type;
  TableSummary: IDLNS.Type;
  Status: IDLNS.Type;
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

/// Builds every named Candid type this package's service surface uses,
/// keyed by name — `status`'s own type plus the WS protocol's types
/// (`mo:duel-game-core/ws`, the ONLY way to mutate game state — see
/// `../backend/src/ws.mo`'s doc header), including the ones nothing in the
/// declared `IDL.Service` below actually needs
/// (`WebsocketServiceMessageContent` — the open/ack/keep-alive/close
/// envelope `ws.mo`'s CDK dependency sends over the wire, never as a
/// normal method argument/result). Exported (not just used inline by
/// `makeIdlFactory`) so `ws/gateway-protocol.js` can `IDL.encode`/
/// `IDL.decode` against the EXACT same type descriptions — one
/// definition, so the two can't drift apart.
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
    // A submit/leave/reset carried a stale gen/turn — see lib.mo's
    // Table.gen doc and gateway-client.ts's `_isRetryAmbiguousError`.
    stale: IDL.Null,
    // joinTable named a TableId no table in the registry currently
    // holds (never existed, or already garbage-collected).
    noSuchTable: IDL.Null,
    // joinTable targeted a code-protected table with a missing or
    // wrong code.
    badCode: IDL.Null,
  });
  // No JoinOk/SubmitOk/RematchOk here: those were only ever the result
  // types of the plain join/submit/rematch Candid methods, which don't
  // exist any more (mutation goes exclusively through ws.mo's ws_message
  // — see this file's header) — `#ok`'s payload never crosses the wire on
  // its own; only a fresh `View` (below) does, via a `#view` push.
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
    }),
    awaitingRematch: IDL.Record({ openSeat: Seat, gen: IDL.Nat }),
    inGame: IDL.Record({
      seat: Seat,
      game: State,
      turn: IDL.Nat,
      youSubmitted: IDL.Bool,
      oppSubmitted: IDL.Bool,
      gen: IDL.Nat,
      secondsUntilIdleReset: IDL.Nat,
      idleTimeoutSecs: IDL.Nat,
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

  // ── The multi-table lobby (mo:duel-game-core's `Registry`) ─────────────
  // `TableId` is a plain `Nat`, never reused even once a table is
  // garbage-collected. `Visibility.code` tables are never listed by
  // `listTables`/`Status.browsing` — reachable only by id + the matching
  // code, both shared with a friend out of band.
  const TableId = IDL.Nat;
  const Visibility = IDL.Variant({ open: IDL.Null, code: IDL.Text });
  const TableSummary = IDL.Record({
    id: TableId,
    p1Open: IDL.Bool,
    p2Open: IDL.Bool,
    waitingSecs: IDL.Nat,
  });
  // The per-caller lobby-scoped screen `status` (and every `#view` push)
  // actually returns — either the browsable table list, or a specific
  // table's own `View` (unchanged above) labeled with which table it's
  // about. Mirrors `TP.SessionStatus<S>` exactly.
  const Status = IDL.Variant({
    browsing: IDL.Record({ tables: IDL.Vec(TableSummary) }),
    atTable: IDL.Record({ id: TableId, view: View }),
  });

  // ── The WebSocket push transport (mo:duel-game-core/ws) ────────────────
  // Fixed shapes from `ic-websocket-cdk`, mirrored here so a canister
  // that wires `Ws.attach` can be talked to — either by a real Gateway
  // relay speaking `ic-websocket-js`'s wire protocol, or by
  // `ws/gateway-protocol.js`'s embedded-gateway client (self-registers
  // as its own gateway and calls these same four methods directly — see
  // `frontend/README.md`'s "Real-time push" section). A canister that
  // never wires `Ws` simply never gets these four methods called.
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

  // The service-message envelope the CDK itself sends/expects inside a
  // `WebsocketMessage.content` blob whenever `is_service_message` is
  // true — mirrors `ic-websocket-cdk`'s `Types.WebsocketServiceMessageContent`
  // (Motoko's `to_candid`/`from_candid` on THAT exact shape). Only
  // `ws/gateway-protocol.js` touches this; it's not part of the
  // canister's own declared Candid interface (the CDK reads/writes it
  // through opaque `Blob`s, same as it does the application `WsMsg`
  // below), so it's not referenced from the `IDL.Service` this function
  // helps build.
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

  // The one application message type shared by both directions of the
  // WS channel — mirrors `Ws.Msg<S, M>` on the backend exactly.
  const WsRequest = IDL.Variant({
    createTable: IDL.Record({ seat: Seat, visibility: Visibility }),
    joinTable: IDL.Record({ id: TableId, seat: Seat, code: IDL.Opt(IDL.Text) }),
    // `gen`/`turn`: the caller's last-observed match generation/round —
    // see lib.mo's `Table.gen` doc and this file's `Err.stale` comment.
    submit: IDL.Record({ gen: IDL.Nat, turn: IDL.Nat, move: Action }),
    rematch: IDL.Null,
    leave: IDL.Record({ gen: IDL.Nat }),
    reset: IDL.Record({ gen: IDL.Nat }),
    ackEnded: IDL.Null,
    status: IDL.Null,
  });
  // `reqId` (opaque, client-chosen) lets a client tell "the reply to MY
  // request" apart from an unsolicited push this same connection gets
  // because the OTHER seat (or another lobby watcher) acted (`ws.mo`'s
  // `afterMutation` pushes to every relevant session) — see
  // `../backend/README.md`'s "The wire protocol" section and
  // `ws/gateway-client.js`'s `_pending` doc for the bug this closes.
  // `ws.mo` only ever echoes it back verbatim on `#view`/`#err`; a push
  // to anyone but the acting session always carries `null`.
  const WsMsg = IDL.Variant({
    req: IDL.Record({ sid: IDL.Text, req: WsRequest, reqId: IDL.Opt(IDL.Nat64) }),
    view: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), view: Status }),
    err: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), err: Err }),
  });

  return {
    Seat, Verdict, End, Err, View, TableId, Visibility, TableSummary, Status,
    ClientKey, WsResult, CanisterWsOpenArguments, CanisterWsCloseArguments,
    WebsocketMessage, CanisterWsMessageArguments,
    CanisterWsGetMessagesArguments, CanisterOutputMessage,
    CanisterOutputCertifiedMessages, CanisterWsGetMessagesResult,
    WebsocketServiceMessageContent, WsRequest, WsMsg,
  };
}

/// Wraps a game's `{ Action, State }` Candid types in the fixed
/// TwoPlayer service shape and returns a ready-to-use `idlFactory`.
export function makeIdlFactory(buildGameTypes: BuildGameTypes) {
  return ({ IDL }: { IDL: typeof IDLNS }) => {
    const { Action, State } = buildGameTypes({ IDL });
    const t = buildEngineTypes({ IDL, Action, State });

    return IDL.Service({
      // No createTable/joinTable/submit/rematch/leave/reset/ackEnded here
      // — mutation goes exclusively through ws_message below (see this
      // file's header and `../backend/src/ws.mo`'s doc header for why
      // there's no fallback).
      status: IDL.Func([IDL.Text], [t.Status], ["query"]),
      ws_open: IDL.Func([t.CanisterWsOpenArguments], [t.WsResult], []),
      ws_close: IDL.Func([t.CanisterWsCloseArguments], [t.WsResult], []),
      // `msgType` (the second parameter) is a plain `opt blob`, not
      // `opt WsMsg` — the canister ignores its VALUE either way (see
      // `../backend/src/ws.mo`'s doc header: this parameter exists only
      // for `ic-websocket-cdk`'s own convention of shaping a canister's
      // Candid interface with SOME app-message type, never actually read
      // by anything on that side), so there's nothing to gain from
      // spelling out the full `WsMsg` variant here — a blob is simpler,
      // and independent of any game's `Action`/`State` shape. `content`
      // (inside `msg`, the first parameter) carries the real, certified
      // message; `gateway-transport.js`'s `send()` packs the exact same
      // encoded bytes into this second parameter too, purely so
      // `from_candid` on the backend could recover the original
      // `Ws.Msg` if it ever needed to (see that method's own doc).
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
