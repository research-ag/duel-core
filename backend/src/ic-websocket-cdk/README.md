This is a copy of https://mops.one/ic-websocket-cdk@0.4.1 with patches:

1) all aync functions are now async*, except for those that are required to be self-calls (timer callbacks)
2) Bump ic-certification = "0.1.3" => ic-certification = "1.1.0"
3) Bump sha2 = "0.1.0" => sha2 = "0.2.5"
4) Bump cbor = "1.0.0" => cbor = "4.1.0"
5) base => core migration