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
/// ic0.app, or the public gateway otherwise.
export function deriveHost(): string {
  const { protocol, hostname, port } = window.location;
  if (hostname.endsWith("localhost")) {
    return `${protocol}//localhost${port ? ":" + port : ""}`;
  }
  if (hostname.endsWith(".icp0.io") || hostname.endsWith(".ic0.app")) {
    const dot = hostname.indexOf(".");
    return `${protocol}//${hostname.slice(dot + 1)}${port ? ":" + port : ""}`;
  }
  return "https://icp0.io";
}
