#!/bin/sh
# icp.yaml sync step for the backend: after an install, reinstall or
# upgrade on mainnet, puts the module the canister now runs into
# hosty.live's module store, where frontends and bots fetch it by the
# canister's public module hash. Needs a hosty.live API token in
# HOSTY_TOKEN or ~/.config/hosty/token (hosty.live, Settings, AI agent
# access). A backend installed through hosty.live is in the store
# already. By hand: sh publish_wasm.sh [canister name] (environment ic).
# See the duel-game-core backend README, "Downloadable wasm".
set -eu

env=${ICP_CLI_ENVIRONMENT:-ic}
name=${1:-backend}
api=https://api.hosty.live
token_file=$HOME/.config/hosty/token

if [ "$env" != ic ]; then
  echo "publish_wasm: $env is not mainnet, nothing to publish"
  exit 0
fi
if [ -z "${HOSTY_TOKEN:-}" ] && [ -r "$token_file" ]; then
  HOSTY_TOKEN=$(cat "$token_file")
fi
if [ -z "${HOSTY_TOKEN:-}" ]; then
  echo "publish_wasm: set HOSTY_TOKEN or write it to $token_file, then run: icp sync $name -e $env" >&2
  exit 1
fi

while [ ! -f icp.yaml ] && [ "$PWD" != / ]; do cd ..; done
cid=${ICP_CLI_CID:-$(icp canister status "$name" -e "$env" -i)}
wasm=.icp/cache/artifacts/$name
[ -f "$wasm" ] || { echo "publish_wasm: no build artifact at $wasm" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
hash=$(sha256 "$wasm")
live_hash=$(icp canister status "$cid" -e "$env" --json | sed -n 's/.*"module_hash":"0x\([0-9a-f]*\)".*/\1/p')
if [ "$hash" != "$live_hash" ]; then
  echo "publish_wasm: $wasm ($hash) is not the module $cid runs ($live_hash)" >&2
  exit 1
fi

curl -sSf -X POST "$api/modules" -H "Authorization: Bearer $HOSTY_TOKEN" -F "wasm=@$wasm" >/dev/null
curl -sSf -X POST "$api/modules/$hash/verify" -H "Content-Type: application/json" \
  -d "{\"canisterId\":\"$cid\"}" >/dev/null
if ! curl -sSf "$api/modules/$hash/meta" | grep -q '"verified":true'; then
  echo "publish_wasm: the store holds $hash but has not verified it against $cid" >&2
  exit 1
fi
echo "publish_wasm: $(wc -c <"$wasm" | tr -d ' ') bytes ($hash) at $api/modules/$hash"
