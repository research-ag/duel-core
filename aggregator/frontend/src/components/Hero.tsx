// The landing hero: a slow crossfade through the registered games' own
// banners behind the headline, so the page's first impression is the
// games themselves. Cycling stops under prefers-reduced-motion.

import { useEffect, useState } from "react";

import { useBanner } from "../hooks/useBanner";
import type { AggregatorActor, GameView } from "../types";
import { ArrowDown, ArrowRight } from "./Icons";

const SLIDE_MS = 6500;
const MAX_SLIDES = 6;

export function Hero({
  games,
  actor,
  developers,
  onBuild,
}: {
  games: GameView[];
  actor: AggregatorActor | undefined;
  developers: number;
  onBuild: () => void;
}) {
  const slides = games.slice(0, MAX_SLIDES);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (slides.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(
      () => setActive((a) => (a + 1) % slides.length),
      SLIDE_MS
    );
    return () => clearInterval(id);
  }, [slides.length]);

  return (
    <section className="hero">
      <div className="hero-montage" aria-hidden="true">
        {slides.map((g, i) => (
          <Slide
            key={g.frontendCanisterId.toText()}
            game={g}
            actor={actor}
            on={i === active % slides.length}
          />
        ))}
      </div>
      <div className="hero-veil" aria-hidden="true" />
      {slides.length > 1 && (
        <div className="hero-dots" aria-hidden="true">
          {slides.map((g, i) => (
            <i
              key={g.frontendCanisterId.toText()}
              className={i === active % slides.length ? "on" : ""}
            />
          ))}
        </div>
      )}
      <div className="wrap">
        <span className="eyebrow">Two players · one table · on-chain</span>
        <h1>
          Pick your <em>duel.</em>
        </h1>
        <p className="hero-lede">
          Head-to-head games built on the Duel framework and running entirely on
          the Internet Computer. Open a table, send the link, play — or build a
          game of your own and list it here.
        </p>
        <div className="hero-row">
          <a className="btn primary" href="#games">
            Browse games <ArrowDown />
          </a>
          <button type="button" className="btn" onClick={onBuild}>
            Build your own <ArrowRight />
          </button>
          {games.length > 0 && (
            <div className="hero-stats">
              <span>
                <b>{games.length}</b>
                {games.length === 1 ? "game" : "games"}
              </span>
              <span>
                <b>{developers}</b>
                {developers === 1 ? "developer" : "developers"}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Slide({
  game,
  actor,
  on,
}: {
  game: GameView;
  actor: AggregatorActor | undefined;
  on: boolean;
}) {
  const banner = useBanner(actor, game.frontendCanisterId);
  return (
    <div
      className={`slide${on && banner ? " on" : ""}`}
      style={banner ? { backgroundImage: `url(${banner})` } : undefined}
    />
  );
}
