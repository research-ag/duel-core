import { useCallback, useEffect, useState } from "react";

import type { AggregatorActor, GameView } from "../types";

export interface Games {
  games: GameView[];
  loading: boolean;
  reload(): void;
}

/// The full public game list — filtering by developer/title happens
/// client-side in App.tsx, since `listGames` is expected to stay small
/// enough (a curated registry, not a user-generated content firehose)
/// that shipping the whole list once and filtering in memory beats a
/// round trip per filter change.
export function useGames(actor: AggregatorActor | undefined): Games {
  const [games, setGames] = useState<GameView[]>([]);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(0);

  const reload = useCallback(() => setGen((g) => g + 1), []);

  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const list = await actor.listGames();
      if (cancelled) return;
      setGames(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [actor, gen]);

  return { games, loading, reload };
}
