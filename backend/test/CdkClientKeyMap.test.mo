// Regression test for the vendored CDK's `remove_client`: a belated removal
// for a superseded `ClientKey` must not erase a newer, live connection's
// `CURRENT_CLIENT_KEY_MAP` entry.
import State "mo:ic-websocket-cdk/State";
import Types "mo:ic-websocket-cdk/Types";
import Principal "mo:core/Principal";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";

let gateway = Principal.fromText("aaaaa-aa");
let clientP = Principal.fromText("2vxsx-fae");

// ── 1. A belated remove_client for a SUPERSEDED client_key (older nonce,
//      same principal) must NOT erase the newer, live one's
//      CURRENT_CLIENT_KEY_MAP entry. ────────────────────────────────────────
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
//      still clear the lookup entirely ──────────────────────────────────────
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
