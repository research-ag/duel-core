import { test } from "node:test";
import assert from "node:assert/strict";
import { IDL } from "@icp-sdk/core/candid";
import { buildEngineTypes, makeIdlFactory } from "../src/idl.js";

/// A tiny sample game's own Candid types — stands in for a real
/// GamePlugin.idlTypes(), exercising buildEngineTypes/makeIdlFactory the
/// same way a real game would.
function sampleGameTypes({ IDL: I }: { IDL: typeof IDL }) {
  return {
    Action: I.Variant({ pass: I.Null, shoot: I.Nat }),
    State: I.Record({ hp: I.Nat }),
  };
}

test("buildEngineTypes builds every named type without throwing", () => {
  const { Action, State } = sampleGameTypes({ IDL });
  const t = buildEngineTypes({ IDL, Action, State });
  for (const key of [
    "Seat", "Verdict", "End", "Err", "View", "LeaderboardEntry",
    "ClientKey", "WsResult", "CanisterWsOpenArguments", "CanisterWsCloseArguments",
    "WebsocketMessage", "CanisterWsMessageArguments", "CanisterWsGetMessagesArguments",
    "CanisterOutputMessage", "CanisterOutputCertifiedMessages", "CanisterWsGetMessagesResult",
    "WebsocketServiceMessageContent", "WsRequest", "WsMsg",
  ] as const) {
    assert.ok(t[key], `missing type: ${key}`);
  }
});

test("makeIdlFactory produces a Service with status + get_leaderboard + bot discovery + the four ws_* methods, no plain mutating game method", () => {
  const idlFactory = makeIdlFactory(sampleGameTypes);
  const service = idlFactory({ IDL });
  // IDL.Service exposes its method table via ._fields (array of [name,
  // FuncClass]).
  const names = (service as unknown as { _fields: Array<[string, unknown]> })._fields.map(
    ([name]) => name,
  );
  assert.deepEqual(
    [...names].sort(),
    [
      "status", "get_leaderboard", "register_bot", "unregister_bot", "list_bots",
      "ws_close", "ws_get_messages", "ws_message", "ws_open",
    ].sort(),
  );
  for (const forbidden of ["join", "submit", "rematch", "leave", "reset", "claimWin", "ackEnded"]) {
    assert.ok(!names.includes(forbidden), `service must not expose a plain "${forbidden}" method`);
  }
});

test("View round-trips through Candid encode/decode for a game's own State shape", () => {
  const { Action, State } = sampleGameTypes({ IDL });
  const t = buildEngineTypes({ IDL, Action, State });

  const view = {
    inGame: {
      mode: { simultaneous: null },
      seat: { p1: null },
      game: { hp: 10n },
      turn: 3n,
      youSubmitted: true,
      oppSubmitted: false,
      gen: 1n,
      secondsUntilIdleReset: 60n,
      idleTimeoutSecs: 60n,
      claimWinAvailable: false,
      secondsUntilClaimable: 20n,
      claimTimeoutSecs: 20n,
    },
  };
  const bytes = IDL.encode([t.View], [view]);
  const [decoded] = IDL.decode([t.View], bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  assert.deepEqual(decoded, view);
});

test("WsRequest round-trips a game's own Action through the submit variant", () => {
  const { Action, State } = sampleGameTypes({ IDL });
  const t = buildEngineTypes({ IDL, Action, State });

  const req = { submit: { gen: 1n, turn: 2n, move: { shoot: 5n } } };
  const bytes = IDL.encode([t.WsRequest], [req]);
  const [decoded] = IDL.decode(
    [t.WsRequest],
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  assert.deepEqual(decoded, req);
});

test("WsRequest round-trips the claimWin variant", () => {
  const { Action, State } = sampleGameTypes({ IDL });
  const t = buildEngineTypes({ IDL, Action, State });

  const req = { claimWin: { gen: 1n } };
  const bytes = IDL.encode([t.WsRequest], [req]);
  const [decoded] = IDL.decode(
    [t.WsRequest],
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  assert.deepEqual(decoded, req);
});

test("Err round-trips every variant shape", () => {
  const { Action, State } = sampleGameTypes({ IDL });
  const t = buildEngineTypes({ IDL, Action, State });

  for (const err of [
    { seatTaken: null },
    { notSeated: null },
    { alreadySubmitted: null },
    { illegalMove: "not your turn" },
    { wrongPhase: "game is over" },
    { reserved: { secondsLeft: 9n } },
    { notIdle: { secondsLeft: 1n } },
    { notOverdue: { secondsLeft: 5n } },
    { stale: null },
    { unauthorized: null },
  ]) {
    const bytes = IDL.encode([t.Err], [err]);
    const [decoded] = IDL.decode(
      [t.Err],
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    assert.deepEqual(decoded, err);
  }
});
