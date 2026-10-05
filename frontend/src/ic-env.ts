// Optional helper for an ICP-hosted frontend; `start()` never calls it.

/// The `HttpAgent` host for the page's location. Calls must stay same-site
/// (CORS and the frontend canister's CSP `connect-src`): on icp0.io/ic0.app
/// the bare parent domain is the API host, so the canister-id subdomain
/// is stripped; on icp.net the parent domain is not an API host, but the
/// page's own origin proxies `/api`, so it is kept as-is. `icp-api.io` is
/// the last resort (a deployment relying on it must add it to its CSP).
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
