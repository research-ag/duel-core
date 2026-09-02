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

/// Builds every named Candid type this package's service surface uses,
/// keyed by name — the plain 7 methods' types AND the WS protocol's
/// types (`mo:duel-game-core/Ws`), including the ones nothing in the
/// declared `IDL.Service` below actually needs
/// (`WebsocketServiceMessageContent` — the open/ack/keep-alive/close
/// envelope `Ws.mo`'s CDK dependency sends over the wire, never as a
/// normal method argument/result). Exported (not just used inline by
/// `makeIdlFactory`) so `ws/gateway-protocol.js` can `IDL.encode`/
/// `IDL.decode` against the EXACT same type descriptions — one
/// definition, so the two can't drift apart.
export function buildEngineTypes({ IDL, Action, State }) {
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
    stagingYou: IDL.Record({
      seat: Seat,
      reservedForPartner: IDL.Bool,
      secondsUntilReclaimable: IDL.Nat,
    }),
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

  // ── The WebSocket push transport (mo:duel-game-core/Ws) ────────────────
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
    join: Seat,
    submit: Action,
    rematch: IDL.Null,
    leave: IDL.Null,
    reset: IDL.Null,
    ackEnded: IDL.Null,
    status: IDL.Null,
  });
  // `reqId` (opaque, client-chosen) lets a client tell "the reply to MY
  // request" apart from an unsolicited push this same connection gets
  // because the OTHER seat acted (`Ws.mo`'s `pushRelevant` pushes to both
  // participants of a match) — see `../backend/README.md`'s "The wire
  // protocol" section and `ws/gateway-client.js`'s `_pending` doc for the
  // bug this closes. `Ws.mo` only ever echoes it back verbatim on `#view`/
  // `#err`; a push to the non-acting participant always carries `null`.
  const WsMsg = IDL.Variant({
    req: IDL.Record({ sid: IDL.Text, req: WsRequest, reqId: IDL.Opt(IDL.Nat64) }),
    view: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), view: View }),
    err: IDL.Record({ reqId: IDL.Opt(IDL.Nat64), err: Err }),
  });

  return {
    Seat, Verdict, End, Err, JoinOk, SubmitOk, RematchOk, View,
    ClientKey, WsResult, CanisterWsOpenArguments, CanisterWsCloseArguments,
    WebsocketMessage, CanisterWsMessageArguments,
    CanisterWsGetMessagesArguments, CanisterOutputMessage,
    CanisterOutputCertifiedMessages, CanisterWsGetMessagesResult,
    WebsocketServiceMessageContent, WsRequest, WsMsg,
  };
}

/// Wraps a game's `{ Action, State }` Candid types in the fixed
/// TwoPlayer service shape and returns a ready-to-use `idlFactory`.
export function makeIdlFactory(buildGameTypes) {
  return ({ IDL }) => {
    const { Action, State } = buildGameTypes({ IDL });
    const t = buildEngineTypes({ IDL, Action, State });

    return IDL.Service({
      join: IDL.Func(
        [IDL.Text, t.Seat],
        [IDL.Variant({ ok: t.JoinOk, err: t.Err })],
        [],
      ),
      submit: IDL.Func(
        [IDL.Text, Action],
        [IDL.Variant({ ok: t.SubmitOk, err: t.Err })],
        [],
      ),
      rematch: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: t.RematchOk, err: t.Err })],
        [],
      ),
      leave: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: IDL.Null, err: t.Err })],
        [],
      ),
      reset: IDL.Func(
        [IDL.Text],
        [IDL.Variant({ ok: IDL.Null, err: t.Err })],
        [],
      ),
      ackEnded: IDL.Func([IDL.Text], [], []),
      status: IDL.Func([IDL.Text], [t.View], ["query"]),
      ws_open: IDL.Func([t.CanisterWsOpenArguments], [t.WsResult], []),
      ws_close: IDL.Func([t.CanisterWsCloseArguments], [t.WsResult], []),
      ws_message: IDL.Func(
        [t.CanisterWsMessageArguments, IDL.Opt(t.WsMsg)],
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
