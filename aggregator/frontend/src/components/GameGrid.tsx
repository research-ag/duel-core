import { useEffect, useMemo, useRef, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { CycleStore } from "../cycles";
import {
  bandOf,
  cyclesOfGame,
  formatTC,
  trackGame,
  useCycleStore,
} from "../cycles";
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
  onInfo,
}: {
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  ownPrincipal: Principal | undefined;
  /// `[principal text, display name]`, sorted — see App.tsx.
  developers: [string, string][];
  onEdit: (game: GameView) => void;
  onDeleted: () => void;
  onInfo: (game: GameView) => void;
}) {
  const [search, setSearch] = useState("");
  const [developer, setDeveloper] = useState<string>("all");
  const [lowOnly, setLowOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const store = useCycleStore();

  useEffect(() => {
    for (const g of games) trackGame(g);
  }, [games]);

  const lowCount = useMemo(
    () => games.filter((g) => isLow(store, g)).length,
    [games, store]
  );

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
      if (lowOnly && !isLow(store, g)) return false;
      if (
        q &&
        !g.title.toLowerCase().includes(q) &&
        !g.description.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [games, search, developer, lowOnly, store]);

  const own = useMemo(
    () =>
      ownPrincipal
        ? games.filter((g) => g.developer.toText() === ownPrincipal.toText())
        : [],
    [games, ownPrincipal]
  );

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
          {(lowCount > 0 || lowOnly) && (
            <button
              type="button"
              className={`chip${lowOnly ? " on" : ""}`}
              onClick={() => setLowOnly(!lowOnly)}
              aria-pressed={lowOnly}
            >
              <i className="dot low" aria-hidden="true" />
              Low on cycles ({lowCount})
            </button>
          )}
        </div>
      </div>

      {own.length > 0 && (
        <OwnerStrip games={own} store={store} onInfo={onInfo} />
      )}

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
              onInfo={() => onInfo(g)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function isLow(store: CycleStore, game: GameView): boolean {
  const c = cyclesOfGame(store, game);
  return c != null && bandOf(c) !== "healthy";
}

/// The logged-in developer's games: how many backends are readable,
/// their total, and the one that needs attention first.
function OwnerStrip({
  games,
  store,
  onInfo,
}: {
  games: GameView[];
  store: CycleStore;
  onInfo: (game: GameView) => void;
}) {
  const readable = games
    .map((g) => ({ game: g, cycles: cyclesOfGame(store, g) }))
    .filter((x): x is { game: GameView; cycles: bigint } => x.cycles != null);
  if (readable.length === 0) return null;
  const total = readable.reduce((sum, x) => sum + x.cycles, 0n);
  const low = readable.filter((x) => bandOf(x.cycles) !== "healthy");
  const lowest = readable.reduce((a, b) => (b.cycles < a.cycles ? b : a));
  return (
    <p className="owner-strip">
      <strong>Your games:</strong> {readable.length} backend
      {readable.length === 1 ? "" : "s"}, {formatTC(total)} in total
      {low.length > 0 ? (
        <>
          ,{" "}
          <span className={bandOf(lowest.cycles)}>
            {low.length} running low
          </span>
          {" · "}
          <button
            type="button"
            className="info-link"
            onClick={() => onInfo(lowest.game)}
          >
            {lowest.game.title}: {formatTC(lowest.cycles)}
          </button>
        </>
      ) : (
        ", all healthy"
      )}
      .
    </p>
  );
}
