import { useEffect, useMemo, useRef, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import type { Balance, CycleStore, Status } from "../cycles";
import {
  cyclesOf,
  formatTC,
  readingOfGame,
  statusOf,
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
  onTopUp,
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
  onTopUp: (game: GameView) => void;
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
  const down = useMemo(
    () => games.filter((g) => isDown(store, g)),
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

      {down.length > 0 && (
        <DownStrip games={down} store={store} onTopUp={onTopUp} />
      )}

      {own.length > 0 && (
        <OwnerStrip games={own} store={store} onTopUp={onTopUp} />
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
  const status = statusOf(readingOfGame(store, game));
  return status !== undefined && status !== "healthy";
}

function isDown(store: CycleStore, game: GameView): boolean {
  const status = statusOf(readingOfGame(store, game));
  return status === "down" || status === "frozen";
}

/// The listings whose backend takes no moves, for every visitor: anyone
/// can top one up.
function DownStrip({
  games,
  store,
  onTopUp,
}: {
  games: GameView[];
  store: CycleStore;
  onTopUp: (game: GameView) => void;
}) {
  return (
    <p className="down-strip" role="status">
      <strong>
        {games.length === 1 ? "1 game is" : `${games.length} games are`} out
        of cycles:
      </strong>{" "}
      {games.map((g, i) => {
        const cycles = cyclesOf(readingOfGame(store, g));
        return (
          <span key={g.frontendCanisterId.toText()}>
            {i > 0 && " · "}
            <button
              type="button"
              className="info-link"
              onClick={() => onTopUp(g)}
            >
              {g.title}:{" "}
              {cycles === undefined
                ? "frozen"
                : `likely down at ${formatTC(cycles)}`}
            </button>
          </span>
        );
      })}
      .{" "}
      {games.length === 1
        ? "Its moves are refused until someone tops it up."
        : "Their moves are refused until someone tops them up."}
    </p>
  );
}

const WORST_FIRST: Status[] = ["frozen", "down", "low", "healthy"];

/// The logged-in developer's backends (two listings on one backend
/// count once): how many have a readable balance, their total, and the
/// one that needs attention first.
function OwnerStrip({
  games,
  store,
  onTopUp,
}: {
  games: GameView[];
  store: CycleStore;
  onTopUp: (game: GameView) => void;
}) {
  const byBackend = new Map<
    string,
    { game: GameView; reading: Balance | "frozen"; status: Status }
  >();
  let unreadable = 0;
  for (const game of games) {
    const backend = store.backends.get(game.frontendCanisterId.toText());
    const reading = readingOfGame(store, game);
    const status = statusOf(reading);
    if (!backend || reading == null || status === undefined) {
      unreadable++;
      continue;
    }
    if (!byBackend.has(backend)) byBackend.set(backend, { game, reading, status });
  }
  const known = [...byBackend.values()];
  if (known.length === 0) return null;
  const balances = known.flatMap((x) =>
    x.reading === "frozen" ? [] : [x.reading.cycles]
  );
  const total = balances.reduce((a, b) => a + b, 0n);
  const count = (status: Status) => known.filter((x) => x.status === status).length;
  const down = count("frozen") + count("down");
  const low = count("low");
  const worst = known.reduce((a, b) => {
    const order = WORST_FIRST.indexOf(a.status) - WORST_FIRST.indexOf(b.status);
    if (order !== 0) return order < 0 ? a : b;
    if (a.reading === "frozen" || b.reading === "frozen") return a;
    return b.reading.cycles < a.reading.cycles ? b : a;
  });
  return (
    <p className="owner-strip">
      <strong>Your games:</strong> {known.length} backend
      {known.length === 1 ? "" : "s"}
      {balances.length === known.length
        ? `, ${formatTC(total)} in total`
        : balances.length > 0 &&
          `, ${formatTC(total)} in the ${balances.length} not frozen`}
      {down > 0 && (
        <>
          , <span className="down">{down} out of cycles</span>
        </>
      )}
      {low > 0 && (
        <>
          , <span className="low">{low} running low</span>
        </>
      )}
      {worst.status !== "healthy" ? (
        <>
          {" · "}
          <button
            type="button"
            className="info-link"
            onClick={() => onTopUp(worst.game)}
          >
            {worst.game.title}:{" "}
            {worst.reading === "frozen"
              ? "frozen"
              : formatTC(worst.reading.cycles)}
          </button>
        </>
      ) : unreadable > 0 ? (
        ", those healthy"
      ) : (
        ", all healthy"
      )}
      {unreadable > 0 &&
        ` (${unreadable} listing${unreadable === 1 ? "" : "s"} without a balance)`}
      .
    </p>
  );
}
