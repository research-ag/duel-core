// A listing's details, opened from the card's info button. The backend
// is never stored here: it is read live from the frontend's `ic_env`
// cookie (canisterHttp.ts), so a frontend that relinks shows its new
// backend on the next page load. The backend view lists every listed
// frontend whose cookie names the same backend, by asking each of them.

import { useEffect, useState } from "react";

import { backendOf, rawUrl, semanticsOf, serves } from "../canisterHttp";
import { grafanaUrlOf } from "../grafana";
import type { GameView } from "../types";
import { gameUrl, optToMaybe } from "../types";
import { CodeBlock } from "./CodeBlock";
import { ArrowRight, Brush } from "./Icons";
import { Modal } from "./Modal";

/// `undefined` while the lookup runs, `null` when there is no answer.
type Lookup<T> = T | null | undefined;

export function GameInfoModal({
  game,
  games,
  onClose,
  onOwnFrontend,
}: {
  game: GameView;
  games: GameView[];
  onClose: () => void;
  onOwnFrontend: () => void;
}) {
  const [backend, setBackend] = useState<Lookup<string>>(undefined);
  const [showBackend, setShowBackend] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void backendOf(game.frontendCanisterId).then((id) => {
      if (!cancelled) setBackend(id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [game]);

  return (
    <Modal onClose={onClose} className="info-modal">
      {showBackend && backend ? (
        <BackendInfo
          backend={backend}
          game={game}
          games={games}
          onBack={() => setShowBackend(false)}
        />
      ) : (
        <FrontendInfo
          game={game}
          backend={backend}
          onBackend={() => setShowBackend(true)}
          onOwnFrontend={onOwnFrontend}
        />
      )}
    </Modal>
  );
}

function FrontendInfo({
  game,
  backend,
  onBackend,
  onOwnFrontend,
}: {
  game: GameView;
  backend: Lookup<string>;
  onBackend: () => void;
  onOwnFrontend: () => void;
}) {
  const developer =
    optToMaybe(game.developerDisplayName) ?? game.developer.toText();
  return (
    <>
      <div className="modal-kicker">Frontend</div>
      <h2 className="modal-title">{game.title}</h2>
      <dl className="info-rows">
        <dt>Address</dt>
        <dd>
          <a href={gameUrl(game)} target="_blank" rel="noreferrer">
            {gameUrl(game)}
          </a>
        </dd>
        <dt>Frontend canister</dt>
        <dd className="mono">{game.frontendCanisterId.toText()}</dd>
        <dt>Developer</dt>
        <dd>{developer}</dd>
        <dt>Backend canister</dt>
        <dd>
          {backend === undefined && (
            <span className="faint">Looking it up…</span>
          )}
          {backend === null && (
            <span className="faint">
              Not published: this frontend sets no backend in its ic_env cookie.
            </span>
          )}
          {backend && (
            <button
              type="button"
              className="info-link mono"
              onClick={onBackend}
            >
              {backend} <ArrowRight />
            </button>
          )}
        </dd>
      </dl>
      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onOwnFrontend}>
          <Brush />
          Make own frontend
        </button>
      </div>
    </>
  );
}

function BackendInfo({
  backend,
  game,
  games,
  onBack,
}: {
  backend: string;
  game: GameView;
  games: GameView[];
  onBack: () => void;
}) {
  const [semantics, setSemantics] = useState<Lookup<string>>(undefined);
  const [metrics, setMetrics] = useState<boolean | undefined>(undefined);
  const [grafana, setGrafana] = useState<Lookup<string>>(undefined);
  const [players, setPlayers] = useState<GameView[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hasMetrics = await serves(backend, "/metrics");
      if (cancelled) return;
      setMetrics(hasMetrics);
      const url = hasMetrics
        ? await grafanaUrlOf(backend).catch(() => undefined)
        : undefined;
      if (!cancelled) setGrafana(url ?? null);
    })();
    void semanticsOf(backend).then((text) => {
      if (!cancelled) setSemantics(text ?? null);
    });
    void Promise.all(games.map((g) => backendOf(g.frontendCanisterId))).then(
      (ids) => {
        if (!cancelled) setPlayers(games.filter((_, i) => ids[i] === backend));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [backend, games]);

  return (
    <>
      <button type="button" className="info-back" onClick={onBack}>
        ← {game.title}
      </button>
      <div className="modal-kicker">Backend</div>
      <h2 className="modal-title mono info-id">{backend}</h2>
      <dl className="info-rows">
        <dt>Metrics</dt>
        <dd>
          {metrics === undefined && <span className="faint">Checking…</span>}
          {metrics === false && <span className="faint">Not served</span>}
          {metrics && (
            <a
              href={rawUrl(backend, "/metrics")}
              target="_blank"
              rel="noreferrer"
            >
              /metrics
            </a>
          )}
        </dd>
        <dt>Grafana</dt>
        <dd>
          {grafana === undefined && (
            <span className="faint">
              Looking it up (a new dashboard takes a few seconds)…
            </span>
          )}
          {grafana === null && (
            <span className="faint">
              {metrics
                ? "Not ready yet; reopen this in a minute."
                : "Needs /metrics."}
            </span>
          )}
          {grafana && (
            <a href={grafana} target="_blank" rel="noreferrer">
              Dashboard
            </a>
          )}
        </dd>
        <dt>Self-description</dt>
        <dd>
          {semantics === undefined && <span className="faint">Checking…</span>}
          {semantics === null && <span className="faint">Not served</span>}
          {semantics && (
            <a
              href={rawUrl(backend, "/semantics")}
              target="_blank"
              rel="noreferrer"
            >
              /semantics
            </a>
          )}
        </dd>
      </dl>

      <h3 className="info-heading">Frontends playing this backend</h3>
      {players === undefined && (
        <p className="faint">Asking {games.length} listed frontends…</p>
      )}
      {players && (
        <ul className="info-list">
          {players.map((g) => (
            <li key={g.frontendCanisterId.toText()}>
              <a href={gameUrl(g)} target="_blank" rel="noreferrer">
                {g.title}
              </a>
              {g.frontendCanisterId.compareTo(game.frontendCanisterId) ===
                "eq" && <span className="faint"> (this one)</span>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="info-heading">Self-description</h3>
      {semantics === undefined && <p className="faint">Loading…</p>}
      {semantics === null && (
        <p className="faint">
          This backend serves no /semantics, so it is not a duel-game-core
          backend, or it predates self-description.
        </p>
      )}
      {semantics && <CodeBlock code={semantics} wrap />}
    </>
  );
}
