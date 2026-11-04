#!/usr/bin/env bash
# Build the shared frontend package, then install + deploy every example
# to the IC. Any arguments are passed through to `icp deploy -e ic`.
#
#   ./deploy_examples.sh            # deploy all examples
#   ./deploy_examples.sh --yes      # e.g. forward a flag to icp deploy
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Each backend's sync step publishes its module to hosty.live's module
# store with this token (see backend/README.md, "Downloadable wasm").
if [ -z "${HOSTY_TOKEN:-}" ]; then
  HOSTY_TOKEN=$(cat "$HOME/.config/hosty/token") ||
    { echo "set HOSTY_TOKEN or write it to ~/.config/hosty/token" >&2; exit 1; }
fi
export HOSTY_TOKEN

echo "==> Building frontend/"
(cd "$root/frontend" && npm run build)

# SKIP=N skips the first N examples (alphabetical), e.g. to resume a failed run
skip=${SKIP:-0}
index=0

# Before deploying, every canister of the example already on mainnet that
# holds less than MIN_CYCLES gets TOPUP_CYCLES from the identity's
# balance: an upgrade of a large heap needs headroom above the freezing
# reserve.
min_cycles=${MIN_CYCLES:-500b}
topup=${TOPUP_CYCLES:-500b}

cycles_of() {
  local n=${1%[kmbt]}
  case $1 in
    *k) echo $((n * 1000)) ;;
    *m) echo $((n * 1000000)) ;;
    *b) echo $((n * 1000000000)) ;;
    *t) echo $((n * 1000000000000)) ;;
    *) echo "$1" ;;
  esac
}
min_cycles=$(cycles_of "$min_cycles")

# An upgrade stops a canister and starts it again; icp-cli can begin the
# sync before the start lands ("is stopped"). Wait, then sync again.
wait_running() {
  local ids=.icp/data/mappings/ic.ids.json name i
  for name in $(sed -n 's/^ *"\([^"]*\)": *"[^"]*".*/\1/p' "$ids"); do
    for i in $(seq 30); do
      icp canister status "$name" -e ic | grep -q "Status: Running" && break
      sleep 2
    done
  done
}

top_up_low() {
  local ids=.icp/data/mappings/ic.ids.json name cycles
  [ -f "$ids" ] || return 0
  for name in $(sed -n 's/^ *"\([^"]*\)": *"[^"]*".*/\1/p' "$ids"); do
    cycles=$(icp canister status "$name" -e ic | sed -n 's/^ *Cycles: *\([0-9_]*\).*/\1/p' | tr -d _)
    [ -n "$cycles" ] || continue
    if [ "$cycles" -lt "$min_cycles" ]; then
      echo "    $name holds $cycles cycles; topping up $topup"
      icp canister top-up "$name" -e ic --amount "$topup"
    fi
  done
}

for example in "$root"/examples/*/; do
  index=$((index + 1))
  [ "$index" -le "$skip" ] && continue
  [ -d "$example/frontend" ] || continue
  name="$(basename "$example")"
  echo "==> Deploying examples/$name"
  (
    cd "$example"
    pushd frontend >/dev/null
    if ! npm i --no-audit --no-fund --no-progress >"$log" 2>&1; then
      cat "$log"
      exit 1
    fi
    popd >/dev/null
    top_up_low
    if ! icp deploy -e ic "$@"; then
      echo "    deploy failed; syncing again once every canister runs"
      wait_running
      icp sync -e ic
    fi
  )
done

echo "==> All examples deployed"
