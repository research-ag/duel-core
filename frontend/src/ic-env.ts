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
/// ic0.app, the page's OWN origin unchanged on icp.net, or the dedicated
/// API gateway as a last resort.
///
/// icp0.io/ic0.app and icp.net both need every agent call to stay
/// SAME-SITE with the page — no third party's CORS policy is ever
/// load-bearing for a known custom-domain host, AND this asset
/// canister's own CSP `connect-src` (see `.ic-assets.json5`) only ever
/// allow-lists `'self'` plus the specific known IC hosts, never an
/// arbitrary third-party gateway — but the two need DIFFERENT
/// treatment to land there:
///
/// - icp0.io/ic0.app: the bare PARENT domain (`icp0.io`, not
///   `<canister-id>.icp0.io`) is itself the well-known boundary-node API
///   host, so stripping the canister-id subdomain is what keeps the call
///   same-site — the per-canister subdomain only reliably sends
///   `Access-Control-Allow-Origin` for ITS OWN registered subdomain, not
///   for a `*.icp.net` page calling cross-origin (a real, reproduced
///   failure mode: see the 007 defect report, finding 03 — every call
///   from a `*.icp.net` page to a hardcoded `icp0.io` fallback was
///   refused by CORS, surfacing as "request timed out waiting for a
///   reply" with no hint the actual cause was a blocked preflight).
/// - icp.net: the OPPOSITE — the bare parent domain (`icp.net`) is
///   icp-cli's own marketing/dashboard host, not an API endpoint at all
///   (it 307-redirects), while THIS PAGE'S OWN `<canister-id>.icp.net`
///   origin already proxies `/api/v2`/`/api/v3` for ANY target canister
///   id, confirmed live (`curl .../api/v2/status` on the asset
///   canister's own origin returns a real IC status response, and an
///   OPTIONS preflight for the BACKEND canister's id at that same origin
///   succeeds too) — so the fix here is to leave `hostname` exactly as
///   `window.location` reports it, keeping the call same-origin (which
///   the CSP's `'self'` already allow-lists for free) rather than
///   stripping to a parent domain that isn't a working API host at all.
///
/// `icp-api.io` remains only the last-resort fallback for a host this
/// function doesn't recognize at all — the same fallback `@icp-sdk/core`'s
/// own `HttpAgent` uses internally when it can't infer a host from
/// `window.location` either. A deployment relying on that fallback branch
/// must also add `icp-api.io` to its own CSP `connect-src` itself — this
/// function has no way to do that for it.
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
