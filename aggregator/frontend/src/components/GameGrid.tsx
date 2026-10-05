import { useEffect, useMemo, useRef, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { AggregatorActor, GameView } from "../types";
import { GameCard } from "./GameCard";
import { Search } from "./Icons";

export function GameGrid({
  games,
  loading,
  actor,
  ownPrincipal,
  developers,
  onEdit,
  onDeleted,
  onOwnFrontend,
}: {
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  ownPrincipal: Principal | undefined;
  /// `[principal text, display name]`, sorted — see App.tsx.
  developers: [string, string][];
  onEdit: (game: GameView) => void;
  onDeleted: () => void;
  onOwnFrontend: (game: GameView) => void;
}) {
  const [search, setSearch] = useState("");
  const [developer, setDeveloper] = useState<string>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return games.filter((g) => {
      if (developer !== "all" && g.developer.toText() !== developer)
        return false;
      if (
        q &&
        !g.title.toLowerCase().includes(q) &&
        !g.description.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [games, search, developer]);

  return (
    <section className="section wrap" id="games">
      <div className="section-head">
        <h2>
          All games
          {!loading && (
            <small>
              {filtered.length === games.length
                ? games.length
                : `${filtered.length} of ${games.length}`}
            </small>
          )}
        </h2>
        <div className="toolbar">
          <label className="search">
            <Search />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search games"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search games"
            />
            <kbd>/</kbd>
          </label>
          {developers.length > 0 && (
            <div
              className="chips"
              role="group"
              aria-label="Filter by developer"
            >
              <button
                type="button"
                className={`chip${developer === "all" ? " on" : ""}`}
                onClick={() => setDeveloper("all")}
              >
                Everyone
              </button>
              {developers.map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  className={`chip${developer === id ? " on" : ""}`}
                  onClick={() => setDeveloper(developer === id ? "all" : id)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card placeholder" aria-hidden="true">
              <span className="card-media">
                <span className="img skeleton" />
              </span>
              <span className="card-body">
                <span className="card-title" />
                <span className="card-meta" />
              </span>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <strong>
            {games.length === 0 ? "No games yet." : "Nothing matches."}
          </strong>
          {games.length === 0
            ? "Be the first to register one."
            : "Try another title or clear the filter."}
        </div>
      ) : (
        <div className="grid">
          {filtered.map((g, i) => (
            <GameCard
              key={g.frontendCanisterId.toText()}
              index={i}
              game={g}
              actor={actor}
              isOwner={
                ownPrincipal !== undefined &&
                g.developer.toText() === ownPrincipal.toText()
              }
              onEdit={() => onEdit(g)}
              onDeleted={onDeleted}
              onOwnFrontend={() => onOwnFrontend(g)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
