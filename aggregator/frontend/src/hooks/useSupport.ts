import { useEffect, useState } from "react";

import type { Support } from "../support";
import { supportOf } from "../support";
import type { GameView } from "../types";

/// `supportOf(game)`, `undefined` while it is asked.
export function useSupport(game: GameView): Support | undefined {
  const [support, setSupport] = useState<Support | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSupport(undefined);
    void supportOf(game).then((s) => {
      if (!cancelled) setSupport(s);
    });
    return () => {
      cancelled = true;
    };
  }, [game]);

  return support;
}
