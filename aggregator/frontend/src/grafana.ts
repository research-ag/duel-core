// The backend's Grafana dashboard, from the promtracker dashboard
// registry (research-ag's openapi-scraper, live at DASHBOARDS). It
// builds dashboards from a canister's `/metrics`, on request: a
// canister it has none for gets `requestRegisterDashboard`, and the
// dashboard appears once its scraper has picked the request up.

import { Actor } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";

import { getAgent } from "./canisterHttp";

const DASHBOARDS = "iu7kc-saaaa-aaaao-bbama-cai";
const REGISTER_WAIT_MS = 12_000;

const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const DashboardData = IDL.Record({
    uid: IDL.Text,
    publicUrl: IDL.Text,
    json: IDL.Text,
  });
  return IDL.Service({
    getDashboard: IDL.Func(
      [IDL.Principal],
      [IDL.Opt(DashboardData)],
      ["query"]
    ),
    requestRegisterDashboard: IDL.Func([IDL.Principal], [], []),
  });
};

interface DashboardActor {
  getDashboard(canister: Principal): Promise<[] | [{ publicUrl: string }]>;
  requestRegisterDashboard(canister: Principal): Promise<void>;
}

async function dashboards(): Promise<DashboardActor> {
  return Actor.createActor(idlFactory, {
    agent: await getAgent(),
    canisterId: DASHBOARDS,
  }) as unknown as DashboardActor;
}

/// The dashboard's public URL, requesting one (and asking once more
/// after `REGISTER_WAIT_MS`) when none exists yet; `undefined` if it is
/// still missing then. Only for a canister that serves `/metrics`.
export async function grafanaUrlOf(
  canister: string
): Promise<string | undefined> {
  const actor = await dashboards();
  const id = Principal.fromText(canister);
  const existing = (await actor.getDashboard(id))[0];
  if (existing) return existing.publicUrl;
  await actor.requestRegisterDashboard(id);
  await new Promise((resolve) => setTimeout(resolve, REGISTER_WAIT_MS));
  return (await actor.getDashboard(id))[0]?.publicUrl;
}
