// Regression test for a real, previously-shipped bug in the vendored
// `ic-websocket-cdk`: `IcWebSocketState.remove_client` used to delete
// `CURRENT_CLIENT_KEY_MAP`'s entry for a principal unconditionally, keyed
// by the bare principal alone rather than the full `ClientKey` (principal
// + client_nonce). A belated `remove_client` for an OLD, already-
// superseded connection (the same principal reconnecting — both `ii:`
// and `an:` identities now persist their keypair across a reload, see
// `frontend/src/identity.ts`) could therefore erase a NEWER, still-live
// connection's own lookup entry, producing a spurious "doesn't have an
// open connection" failure for a client that never actually left.
//
// Every other map `remove_client` touches was already scoped by the
// full `ClientKey` (`Types.compareClientKey`); only this one map was
// keyed by bare principal. This test drives `IcWebSocketState` directly
// — no actor/gateway machinery needed for `add_client`/
// `get_client_key_from_principal`/`remove_client` themselves — mirroring
// how `Hub.test.mo` drives `Ws.Hub` directly instead of the full
// `IcWebSocketCdk` actor.
// Run: moc -r --package core <core/src> --package ic-websocket-cdk <cdk/src> ... test/CdkClientKeyMap.test.mo
import State "mo:ic-websocket-cdk/State";
import Types "mo:ic-websocket-cdk/Types";
import Principal "mo:core/Principal";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let gateway = Principal.fromText("aaaaa-aa");
let clientP = Principal.fromText("2vxsx-fae");

// ── 1. A belated remove_client for a SUPERSEDED client_key (older
//       nonce, same principal) must NOT erase the newer, live one's
//       CURRENT_CLIENT_KEY_MAP entry.
// ────────────────────────────────────────────────────────────────────
await async {
  let state = State.IcWebSocketState(Types.WsInitParams(null, null));

  let oldKey : Types.ClientKey = {
    client_principal = clientP;
    client_nonce = 1;
  };
  let newKey : Types.ClientKey = {
    client_principal = clientP;
    client_nonce = 2;
  };

  state.add_client(oldKey, Types.RegisteredClient(gateway));
  // A reload: the same principal re-registers under a new client_key
  // while the old one is still present (mirrors `ws_open`'s own "remove
  // the old registration, then add the new one" sequencing, but WITHOUT
  // the removal — exactly the window where a belated close can race in).
  state.add_client(newKey, Types.RegisteredClient(gateway));

  switch (state.get_client_key_from_principal(clientP)) {
    case (#Ok(k)) {
      if (not Types.areClientKeysEqual(k, newKey)) {
        Runtime.trap("1a: the newer client_key must be current before the belated close arrives");
      };
    };
    case (#Err(_)) Runtime.trap("1b: the newer client_key must be registered");
  };

  // The belated close for the OLD, superseded connection arrives late.
  await* state.remove_client(oldKey, null, null);

  switch (state.get_client_key_from_principal(clientP)) {
    case (#Ok(k)) {
      if (not Types.areClientKeysEqual(k, newKey)) {
        Runtime.trap("1c: a belated remove_client for the OLD client_key must not erase the NEW one's lookup entry");
      };
    };
    case (#Err(_)) Runtime.trap("1d: the newer client_key must still be resolvable after the stale close");
  };

  Debug.print("1. remove_client() for a superseded client_key leaves a newer live one's lookup intact OK");
};

// ── 2. remove_client() for the CURRENT (not superseded) client_key must
//       still clear the lookup entirely — the fix must not accidentally
//       make removal a no-op in the ordinary, non-racy case.
// ────────────────────────────────────────────────────────────────────
await async {
  let state = State.IcWebSocketState(Types.WsInitParams(null, null));
  let key : Types.ClientKey = { client_principal = clientP; client_nonce = 1 };

  state.add_client(key, Types.RegisteredClient(gateway));
  await* state.remove_client(key, null, null);

  switch (state.get_client_key_from_principal(clientP)) {
    case (#Ok(_)) Runtime.trap("2a: removing the CURRENT client_key must clear the lookup entry");
    case (#Err(_)) {};
  };

  Debug.print("2. remove_client() for the current client_key still clears the lookup entry OK");
};

Debug.print("ALL CDK CLIENT-KEY-MAP CHECKS PASSED");
