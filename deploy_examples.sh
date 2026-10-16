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

# skip the first N examples (alphabetical), e.g. to resume a failed run
skip=0
index=0

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
    icp deploy -e ic "$@"
  )
done

echo "==> All examples deployed"
