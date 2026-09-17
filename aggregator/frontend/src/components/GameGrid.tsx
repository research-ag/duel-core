import { useMemo, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { AggregatorActor, GameView } from "../types";
import { optToMaybe } from "../types";
import { GameCard } from "./GameCard";

export function GameGrid({
  games,
  loading,
  actor,
  ownPrincipal,
  onEdit,
  onDeleted,
}: {
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  ownPrincipal: Principal | undefined;
  onEdit: (game: GameView) => void;
  onDeleted: () => void;
}) {
  const [search, setSearch] = useState("");
  const [developer, setDeveloper] = useState<string>("all");

  const developers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const g of games) {
      const id = g.developer.toText();
      if (!byId.has(id)) byId.set(id, optToMaybe(g.developerDisplayName) ?? id);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [games]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return games.filter((g) => {
      if (developer !== "all" && g.developer.toText() !== developer) return false;
      if (q && !g.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [games, search, developer]);

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <input
            type="text"
            placeholder="Search by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={developer} onChange={(e) => setDeveloper(e.target.value)}>
            <option value="all">All developers</option>
            {developers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <p className="empty">Loading games…</p>
      ) : filtered.length === 0 ? (
        <p className="empty">No games match yet.</p>
      ) : (
        <div className="grid">
          {filtered.map((g) => (
            <GameCard
              key={g.backendCanisterId.toText()}
              game={g}
              actor={actor}
              isOwner={ownPrincipal !== undefined && g.developer.toText() === ownPrincipal.toText()}
              onEdit={() => onEdit(g)}
              onDeleted={onDeleted}
            />
          ))}
        </div>
      )}
    </>
  );
}
