# Self-hosted IC WebSocket Gateway

Config to build and run
[`omnia-network/ic-websocket-gateway`](https://github.com/omnia-network/ic-websocket-gateway)
in Docker — the off-chain relay `duel-game-core`'s optional real-time
push transport needs. The IC has no native WebSocket support: a browser
opens a real WebSocket to this gateway, which polls the canister's
`ws_get_messages` and relays both directions. See
[`../backend/README.md`](../backend/README.md)'s "Optional: real-time
push" section for the full design (`backend/src/Ws.mo`, the frontend's
`ws` param).

This directory holds no vendored copy of that repo — `Dockerfile` clones
it fresh at build time, pinned to a release tag (`GATEWAY_VERSION`), so
there's nothing here to keep in sync with upstream by hand.

## Run it locally

Prerequisites: Docker, and a local IC replica running (`dfx start` or
`icp network start`) with your game's canister deployed to it.

```bash
cd gateway
cp .env.example .env    # defaults point at a replica on 127.0.0.1:4943
docker compose up --build
```

Watch the logs for a line like:

```
INFO ic_websocket_gateway: Gateway Agent principal: <principal>
```

— that's the gateway's own identity, confirming it started and can reach
the replica. It's now listening on `ws://localhost:8080` (see
`GATEWAY_PORT` in `.env` to change the host port).

Stop it with `docker compose down` (or `Ctrl-C` then `docker compose
down` if you didn't run it detached).

## Point a frontend at it

Build `wsConfig`/`IcWebSocket` exactly as
[`../frontend/README.md`](../frontend/README.md)'s "Optional: real-time
push" section shows, but with the gateway URL set to this container
instead of the public one:

```js
const ws = new IcWebSocket("ws://localhost:8080", undefined, wsConfig);
```

`examples/007/frontend/app.js` already does this automatically for a
local deploy — see its `GATEWAY_URL` logic.

## Running against mainnet

Set `IC_NETWORK_URL=https://icp-api.io` in `.env` and rebuild. A gateway
serving real browsers over the public internet also needs TLS in front
of it (this repo doesn't set that up — see upstream's own
[`docker-compose-prod.yml`](https://github.com/omnia-network/ic-websocket-gateway/blob/main/docker-compose-prod.yml)
and its "Obtain a TLS certificate" section if you go this route) and a
stable public host/DNS name, which is outside what a local dev compose
file can give you.

## Why `rust:1.79-slim-bullseye`

`Dockerfile` pins the same Rust version upstream's own Dockerfile does.
This repo's dependency lockfile hasn't been touched since March 2025;
building it with a newer *stable* Rust toolchain fails — the `metrics`
crate (a transitive dependency, pinned to `0.23.0`) trips a borrow-checker
soundness fix landed in rustc since then (`E0521`, tracked at
[rust-lang/rust#141402](https://github.com/rust-lang/rust/issues/141402)).
1.79 predates that fix, so it isn't hit. Confirmed locally: building
outside Docker with the current stable toolchain reproduces the failure;
rolling back to Rust 1.86 (also pre-fix) built clean. Don't bump the
pinned version here without re-checking that the crate versions upstream
locked still compile.

## Verification

Confirmed locally (`GATEWAY_VERSION=v1.4.6`):

- `docker build .` succeeds and produces a 150MB runtime image.
- `docker run ... --help` prints the real CLI (defaults match this
  README/`.env.example`).
- Running it with no reachable replica fails **fast and loud** —
  `could not get new agent: ... Connection refused` — rather than
  hanging or crashing silently, so a misconfigured `IC_NETWORK_URL` is
  obvious immediately.

**Not yet verified: a real round trip** — a canister deployed to a local
replica, this gateway pointed at it, and a browser actually opening a
game, joining, and seeing a push. Do that before relying on this for
anything real; it's a solid, working starting point, not a
battle-tested one.
