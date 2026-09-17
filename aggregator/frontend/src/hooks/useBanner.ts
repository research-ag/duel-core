// Fetches a game's banner (a separate query from listGames/getGame — see
// Types.mo's GameView doc for why) and turns it into an object URL an
// <img> can use. Cached at module scope, keyed by the game's own text
// principal, so re-rendering the grid (a filter change, a new card
// mounting) never re-fetches a banner it already has.

import { useEffect, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { AggregatorActor } from "../types";

const cache = new Map<string, string>();

export function useBanner(actor: AggregatorActor | undefined, gameId: Principal | undefined): string | undefined {
  const key = gameId?.toText();
  const [url, setUrl] = useState<string | undefined>(key ? cache.get(key) : undefined);

  useEffect(() => {
    if (!actor || !gameId || !key || cache.has(key)) return;
    let cancelled = false;
    void (async () => {
      const banner = await actor.getBanner(gameId);
      if (cancelled || banner.length === 0) return;
      const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(banner[0])], { type: "image/png" }));
      cache.set(key, objectUrl);
      setUrl(objectUrl);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, key]);

  return url;
}
