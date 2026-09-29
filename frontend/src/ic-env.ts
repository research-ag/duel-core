// Optional helpers for an ICP asset-canister deployment; `start()` never
// calls them.

/// Decodes the `ic_env` cookie the asset canister sets.
export function readIcEnv(): Record<string, string> {
  const m = document.cookie.match(/(?:^|;\s*)ic_env=([^;]+)/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const part of decodeURIComponent(m[1]).split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/// The `HttpAgent` host for the page's location. Calls must stay same-site
/// (CORS and the asset canister's CSP `connect-src`): on icp0.io/ic0.app
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
