// Actor construction: reads the frontend canister's `ic_env` cookie
// for the backend canister id, derives the right agent host for wherever
// this page is currently served from, and wraps `idlFactory` around it.
// Called once per identity (anonymous, for public browsing before
// login; the real one, once Internet Identity resolves) — see
// hooks/useAuth.ts.

import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import type { Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";

import { idlFactory } from "./idl";
import { deriveHost } from "./ic-env";
import type { AggregatorActor } from "./types";

type Env = { readonly "PUBLIC_CANISTER_ID:backend"?: string };

export function backendCanisterId(): string {
  const id = safeGetCanisterEnv<Env>()?.["PUBLIC_CANISTER_ID:backend"];
  if (!id) {
    throw new Error(
      "Could not find PUBLIC_CANISTER_ID:backend in the ic_env cookie. " +
        "Serve this page from the frontend canister after `icp deploy`.",
    );
  }
  return id;
}

export async function createActor(identity?: Identity): Promise<AggregatorActor> {
  const host = deriveHost();
  const agent = await HttpAgent.create({
    host,
    identity,
    rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY,
  });
  return Actor.createActor(idlFactory, { agent, canisterId: backendCanisterId() }) as unknown as AggregatorActor;
}
