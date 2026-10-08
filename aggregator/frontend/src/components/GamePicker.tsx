// Step 0 of the frontend and bot guides: every listing, each checked
// (support.ts) for what the guide needs, so one that can't be followed
// is shown with its reason instead of failing halfway through.

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { useBanner } from "../hooks/useBanner";
import { useSupport } from "../hooks/useSupport";
import type { Purpose } from "../support";
import { blocker } from "../support";
import type { AggregatorActor, GameView, Target } from "../types";
import { optToMaybe } from "../types";
import { ArrowRight, Search } from "./Icons";

const SEARCH_FROM = 7;

export function GamePicker({
  games,
  loading,
  actor,
  purpose,
  picked,
  onPick,
}: {
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  purpose: Purpose;
  picked: Target | undefined;
  onPick: (target: Target) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) =>
      [g.title, developerOf(g)].some((t) => t.toLowerCase().includes(q))
    );
  }, [games, search]);

  if (games.length === 0)
    return (
      <p className="faint">
        {loading ? "Loading the listed games…" : "No games are listed yet."}
      </p>
    );

  return (
    <>
      {games.length >= SEARCH_FROM && (
        <label className="search picker-search">
          <Search />
          <input
            type="text"
            placeholder="Search games"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search games"
          />
        </label>
      )}
      <div className="picker">
        {shown.map((g) => (
          <PickerRow
            key={g.frontendCanisterId.toText()}
            game={g}
            actor={actor}
            purpose={purpose}
            on={
              picked?.game.frontendCanisterId.compareTo(
                g.frontendCanisterId
              ) === "eq"
            }
            onPick={onPick}
          />
        ))}
        {shown.length === 0 && (
          <p className="faint">No listed game matches “{search}”.</p>
        )}
      </div>
    </>
  );
}

function PickerRow({
  game,
  actor,
  purpose,
  on,
  onPick,
}: {
  game: GameView;
  actor: AggregatorActor | undefined;
  purpose: Purpose;
  on: boolean;
  onPick: (target: Target) => void;
}) {
  const banner = useBanner(actor, game.frontendCanisterId);
  const support = useSupport(game);
  const reason = support && blocker(support, purpose);
  const backend = support?.backend;
  const ready = support !== undefined && !reason && backend !== undefined;

  return (
    <button
      type="button"
      className={`pick${on ? " on" : ""}`}
      disabled={!ready}
      onClick={() => backend && onPick({ game, backend })}
    >
      <span
        className="pick-thumb"
        style={
          banner
            ? ({ "--banner": `url(${banner})` } as CSSProperties)
            : undefined
        }
      />
      <span className="pick-text">
        <span className="pick-title">{game.title}</span>
        <span className="pick-note">
          {support === undefined ? "Checking…" : (reason ?? developerOf(game))}
        </span>
      </span>
      {ready && <ArrowRight />}
    </button>
  );
}

function developerOf(game: GameView): string {
  return optToMaybe(game.developerDisplayName) ?? game.developer.toText();
}
