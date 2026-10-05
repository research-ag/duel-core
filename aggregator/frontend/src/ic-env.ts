// Generic ICP-hosting plumbing for building an agent against an asset
// canister — the same pattern every canister deployed with icp-cli
// needs, independent of anything about this particular app. Kept as a
// small local copy rather than a dependency on the sibling
// `duel-game-core` npm package, since the aggregator is a standalone
// product built on this repo's tooling, not a game on its engine.

/// Derives the right `HttpAgent` host for the page's current location:
/// localhost during local development, the parent domain on icp0.io /
/// ic0.app, the page's own origin unchanged on icp.net, or the dedicated
/// API gateway as a last resort. See `duel-game-core/ic-env.ts`'s own
/// (much longer) doc comment for the full reasoning — identical logic,
/// copied here rather than imported.
export function deriveHost(): string {
  const { protocol, hostname, port } = window.location;
  if (hostname.endsWith("localhost")) {
    return `${protocol}//localhost${port ? ":" + port : ""}`;
  }
  if (hostname.endsWith(".icp0.io") || hostname.endsWith(".ic0.app")) {
    const dot = hostname.indexOf(".");
    return `${protocol}//${hostname.slice(dot + 1)}${port ? ":" + port : ""}`;
  }
  if (hostname.endsWith(".icp.net")) {
    return `${protocol}//${hostname}${port ? ":" + port : ""}`;
  }
  return "https://icp-api.io";
}
