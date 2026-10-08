// Reads other canisters' HTTP interface without going through HTTP: an
// anonymous agent calls their `http_request` as a Candid query, so no
// CORS and no `Set-Cookie` filtering stand in the way. Used to find the
// backend a listed frontend plays (its asset canister's `ic_env`
// cookie, read fresh every page load since a frontend can relink at any
// time) and to read a duel-game-core backend's `/semantics`.

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import type { Principal } from "@icp-sdk/core/principal";

import { deriveHost } from "./ic-env";

/// The fields every `http_request` shares: the asset canister's own
/// request carries `certificate_version` (ignored by a duel backend),
/// and both responses' extra fields are skipped on decode.
const httpIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const Header = IDL.Tuple(IDL.Text, IDL.Text);
  const Request = IDL.Record({
    method: IDL.Text,
    url: IDL.Text,
    headers: IDL.Vec(Header),
    body: IDL.Vec(IDL.Nat8),
    certificate_version: IDL.Opt(IDL.Nat16),
  });
  const Response = IDL.Record({
    status_code: IDL.Nat16,
    headers: IDL.Vec(Header),
    body: IDL.Vec(IDL.Nat8),
  });
  return IDL.Service({
    http_request: IDL.Func([Request], [Response], ["query"]),
  });
};

interface HttpResponse {
  status_code: number;
  headers: [string, string][];
  body: Uint8Array;
}

interface HttpActor {
  http_request(req: {
    method: string;
    url: string;
    headers: [string, string][];
    body: Uint8Array;
    certificate_version: [] | [number];
  }): Promise<HttpResponse>;
}

let agent: Promise<HttpAgent> | undefined;

/// One anonymous agent for every canister this page reads but does not
/// own (also grafana.ts's).
export function getAgent(): Promise<HttpAgent> {
  agent ??= HttpAgent.create({
    host: deriveHost(),
    rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY,
  });
  return agent;
}

async function httpGet(canister: string, path: string): Promise<HttpResponse> {
  const actor = Actor.createActor(httpIdl, {
    agent: await getAgent(),
    canisterId: canister,
  }) as unknown as HttpActor;
  return actor.http_request({
    method: "GET",
    url: path,
    headers: [],
    body: new Uint8Array(),
    certificate_version: [2],
  });
}

/// `PUBLIC_CANISTER_ID:backend` from the `ic_env` cookie the frontend's
/// asset canister sets, or `undefined` when it sets none (another kind
/// of hosting, or an unreachable canister).
export async function readBackendOf(
  frontend: string
): Promise<string | undefined> {
  const res = await httpGet(frontend, "/");
  for (const [name, value] of res.headers) {
    if (name.toLowerCase() !== "set-cookie" || !value.startsWith("ic_env="))
      continue;
    const vars = decodeURIComponent(
      value.slice("ic_env=".length).split(";")[0]
    );
    for (const pair of vars.split("&")) {
      const eq = pair.indexOf("=");
      if (pair.slice(0, eq) === "PUBLIC_CANISTER_ID:backend")
        return pair.slice(eq + 1);
    }
  }
  return undefined;
}

const backends = new Map<string, Promise<string | undefined>>();

/// `readBackendOf`, asked once per frontend per page load; any failure
/// reads as "publishes no backend".
export function backendOf(frontend: Principal): Promise<string | undefined> {
  const id = frontend.toText();
  let p = backends.get(id);
  if (!p) {
    p = readBackendOf(id).catch(() => undefined);
    backends.set(id, p);
  }
  return p;
}

/// The backend's `/semantics` text, or `undefined` when it serves none
/// (not a duel-game-core backend, or one that predates it).
export async function semanticsOf(
  backend: string
): Promise<string | undefined> {
  try {
    const res = await httpGet(backend, "/semantics");
    return res.status_code === 200
      ? new TextDecoder().decode(res.body)
      : undefined;
  } catch {
    return undefined;
  }
}

/// Whether `GET path` on the canister answers 200.
export async function serves(canister: string, path: string): Promise<boolean> {
  try {
    return (await httpGet(canister, path)).status_code === 200;
  } catch {
    return false;
  }
}

/// A plain browser link to a path on the backend's HTTP interface.
export function rawUrl(canister: string, path: string): string {
  return `https://${canister}.raw.icp0.io${path}`;
}
