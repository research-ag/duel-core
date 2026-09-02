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

    // ── Optional: the WebSocket push transport (mo:duel-game-core/Ws) ──────
    // Fixed shapes from `ic-websocket-cdk`, mirrored here so a canister
    // that wires `Ws.attach` can be talked to via `ic-websocket-js`
    // (which reads the message type straight off `ws_message`'s second
    // argument — see `frontend/README.md`). A canister that never wires
    // `Ws` simply never gets these four methods called.
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
    const WsMsg = IDL.Variant({
      req: IDL.Record({ sid: IDL.Text, req: WsRequest }),
      view: View,
      err: Err,
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
      ws_open: IDL.Func([CanisterWsOpenArguments], [WsResult], []),
      ws_close: IDL.Func([CanisterWsCloseArguments], [WsResult], []),
      ws_message: IDL.Func(
        [CanisterWsMessageArguments, IDL.Opt(WsMsg)],
        [WsResult],
        [],
      ),
      ws_get_messages: IDL.Func(
        [CanisterWsGetMessagesArguments],
        [CanisterWsGetMessagesResult],
        ["query"],
      ),
    });
  };
}
