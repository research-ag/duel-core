// What a listing's backend can take: a new frontend needs `/semantics`,
// a bot also needs the canister-player methods (`list_bots` answering
// is the sign). Asked once per frontend per page load, and the bots
// `list_bots` names once per backend.

import { Actor } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

import { backendOf, getAgent, serves } from "./canisterHttp";
import type { GameView } from "./types";

export interface Support {
  backend: string | undefined;
  semantics: boolean;
  bots: boolean;
}

export type Purpose = "frontend" | "bot";

export interface Bot {
  principal: string;
  name: string;
}

const listBotsIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    list_bots: IDL.Func(
      [],
      [IDL.Vec(IDL.Record({ principal: IDL.Principal, name: IDL.Text }))],
      ["query"]
    ),
  });

async function listBots(backend: string): Promise<Bot[] | undefined> {
  try {
    const actor = Actor.createActor(listBotsIdl, {
      agent: await getAgent(),
      canisterId: backend,
    });
    const bots = (await actor.list_bots()) as {
      principal: Principal;
      name: string;
    }[];
    return bots.map((b) => ({ principal: b.principal.toText(), name: b.name }));
  } catch {
    return undefined;
  }
}

const botLists = new Map<string, Promise<Bot[] | undefined>>();

/// The bots registered with `backend`; `undefined` when it does not
/// answer `list_bots`, so takes none.
export function botsOf(backend: string): Promise<Bot[] | undefined> {
  let p = botLists.get(backend);
  if (!p) {
    p = listBots(backend);
    botLists.set(backend, p);
  }
  return p;
}

async function readSupport(game: GameView): Promise<Support> {
  const backend = await backendOf(game.frontendCanisterId);
  if (!backend) return { backend, semantics: false, bots: false };
  const [semantics, bots] = await Promise.all([
    serves(backend, "/semantics"),
    botsOf(backend).then((bots) => bots !== undefined),
  ]);
  return { backend, semantics, bots };
}

const cache = new Map<string, Promise<Support>>();

export function supportOf(game: GameView): Promise<Support> {
  const id = game.frontendCanisterId.toText();
  let p = cache.get(id);
  if (!p) {
    p = readSupport(game);
    cache.set(id, p);
  }
  return p;
}

/// Why the guide for `purpose` can't be followed for this listing, or
/// `undefined` when it can.
export function blocker(s: Support, purpose: Purpose): string | undefined {
  if (!s.backend) return "This listing doesn't publish its backend.";
  if (!s.semantics)
    return "Its backend serves no /semantics, so it can't be built against.";
  if (purpose === "bot" && !s.bots)
    return "This game doesn't accept bots as players.";
  return undefined;
}
