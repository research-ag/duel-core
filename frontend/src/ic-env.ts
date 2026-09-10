// Optional helpers for building an agent/actor against an ICP asset
// canister. Generic IC-hosting plumbing, unrelated to any game's rules —
// `app.js`'s `start()` does not require these; use them (or don't) when
// constructing the `actor` you hand to `start()`.

/// Reads the `ic_env` cookie the asset canister sets, e.g.
/// `PUBLIC_CANISTER_ID:backend=<id>&ic_root_key=<hex>&...`, and returns
/// it decoded as a plain object.
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

/// Derives the right `HttpAgent` host for the page's current location:
/// localhost during local development, the parent domain on icp0.io /
/// ic0.app, or the dedicated API gateway otherwise.
///
/// The fallback is `icp-api.io`, not `icp0.io` — deliberately. A canister
/// served from a THIRD custom domain (an icp-cli-hosted `*.icp.net`, a
/// project's own domain, ...) makes every agent call cross-origin to
/// whatever host this function returns, so that host's CORS policy is
/// load-bearing. `icp0.io`/`ic0.app` serve both raw canister API traffic
/// AND custom-domain-proxied assets, and only reliably send
/// `Access-Control-Allow-Origin` for their OWN registered subdomains — a
/// real, reproduced failure mode (see the 007 defect report, finding 03):
/// every call from a `*.icp.net` page to a hardcoded `icp0.io` fallback
/// was refused by CORS, surfacing as "request timed out waiting for a
/// reply" with no hint that the actual cause was a blocked preflight.
/// `icp-api.io` is the API-only boundary domain built specifically to
/// accept cross-origin calls from ANY origin — the same fallback
/// `@icp-sdk/core`'s own `HttpAgent` uses internally when it can't infer a
/// host from `window.location` either.
export function deriveHost(): string {
  const { protocol, hostname, port } = window.location;
  if (hostname.endsWith("localhost")) {
    return `${protocol}//localhost${port ? ":" + port : ""}`;
  }
  if (hostname.endsWith(".icp0.io") || hostname.endsWith(".ic0.app")) {
    const dot = hostname.indexOf(".");
    return `${protocol}//${hostname.slice(dot + 1)}${port ? ":" + port : ""}`;
  }
  return "https://icp-api.io";
}
