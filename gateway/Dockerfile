# Builds omnia-network/ic-websocket-gateway FROM SOURCE — the off-chain
# relay `duel-game-core`'s optional real-time push transport (Ws.mo, on
# the backend; the `ws` param to `start()`, on the frontend) needs, since
# the IC has no native WebSocket support. See ../backend/README.md's
# "Optional: real-time push" section for the design this serves.
#
# This directory vendors no upstream source — it's cloned fresh at build
# time, pinned to GATEWAY_VERSION, so there is nothing here to keep in
# sync with upstream by hand.
#
# `rust:1.79-slim-bullseye` matches the Rust version the upstream repo's
# OWN Dockerfile pins (last touched 2025-03, so its dependency lockfile
# predates a rustc soundness fix landed since — building with a newer
# stable toolchain fails on the `metrics` crate; 1.79 doesn't hit it).
# Don't bump this without re-checking that.

ARG GATEWAY_VERSION=v1.4.6
ARG GATEWAY_REPO=https://github.com/omnia-network/ic-websocket-gateway.git

FROM rust:1.79-slim-bullseye AS builder
ARG GATEWAY_VERSION
ARG GATEWAY_REPO
RUN apt-get update \
  && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --branch "${GATEWAY_VERSION}" --depth 1 "${GATEWAY_REPO}" .
RUN cargo build --release

FROM debian:bullseye-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /ic-ws-gateway
COPY --from=builder /src/target/release/ic_websocket_gateway .

EXPOSE 8080
EXPOSE 9090

HEALTHCHECK --timeout=30s --interval=30s --retries=5 \
  CMD curl -s -i -N -X GET --head \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: jWPXCaHslL1epUzz0k29Qw==" \
    http://127.0.0.1:8080 \
    | grep -q "HTTP/1.1 101 Switching Protocols" && exit 0 || exit 1

ENTRYPOINT ["/ic-ws-gateway/ic_websocket_gateway"]
