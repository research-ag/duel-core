import { useCallback, useEffect, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import { optToMaybe } from "../types";
import type { AggregatorActor } from "../types";

export interface Profile {
  displayName: string | undefined;
  loading: boolean;
  /// Throws with the backend's own `Err` on failure — callers show it.
  save(name: string): Promise<void>;
}

export function useProfile(actor: AggregatorActor | undefined, principal: Principal | undefined): Profile {
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!actor || !principal) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const profile = optToMaybe(await actor.getProfile(principal));
      if (cancelled) return;
      setDisplayName(profile?.displayName);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [actor, principal]);

  const save = useCallback(
    async (name: string) => {
      if (!actor) return;
      const res = await actor.setDisplayName(name);
      if ("err" in res) throw res.err;
      setDisplayName(name.trim());
    },
    [actor],
  );

  return { displayName, loading, save };
}
