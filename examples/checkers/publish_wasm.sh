#!/bin/sh
# icp.yaml sync step for the backend: uploads the module the canister now
# runs to the canister itself, so anyone can download it at GET /wasm.
# See the duel-game-core backend README, "Downloadable wasm".
set -eu

cid=$ICP_CLI_CID
env=$ICP_CLI_ENVIRONMENT
name=${1:-backend}

while [ ! -f icp.yaml ] && [ "$PWD" != / ]; do cd ..; done
wasm=.icp/cache/artifacts/$name
[ -f "$wasm" ] || { echo "publish_wasm: no build artifact at $wasm" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
local_hash=$(sha256 "$wasm")
live_hash=$(icp canister status "$cid" -e "$env" --json | sed -n 's/.*"module_hash":"0x\([0-9a-f]*\)".*/\1/p')
if [ "$local_hash" != "$live_hash" ]; then
  echo "publish_wasm: $wasm ($local_hash) is not the module $cid runs ($live_hash)" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
split -b 1048576 "$wasm" "$tmp/chunk."

icp canister call "$cid" wasm_upload_begin "()" -e "$env" >/dev/null
for f in "$tmp"/chunk.*; do
  { printf '(blob "'; od -An -v -tx1 "$f" | tr -d ' \n' | sed 's/../\\&/g'; printf '")'; } >"$f.did"
  icp canister call "$cid" wasm_upload_chunk --args-file "$f.did" -e "$env" >/dev/null
done
size=$(wc -c <"$wasm" | tr -d ' ')
icp canister call "$cid" wasm_upload_commit "($size : nat)" -e "$env" >/dev/null
echo "publish_wasm: $size bytes ($local_hash) served at /wasm"
