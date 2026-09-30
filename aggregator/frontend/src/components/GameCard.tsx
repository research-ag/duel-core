import { Fragment, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import { useBanner } from "../hooks/useBanner";
import type { AggregatorActor, Err, GameView } from "../types";
import { errMessage, gameUrl, optToMaybe } from "../types";
import { avatarStyle } from "./DisplayNameEditor";
import { ArrowRight, Pencil, Trash } from "./Icons";
import { Modal } from "./Modal";

export function GameCard({
  index,
  game,
  actor,
  isOwner,
  onEdit,
  onDeleted,
}: {
  index: number;
  game: GameView;
  actor: AggregatorActor | undefined;
  isOwner: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const banner = useBanner(actor, game.backendCanisterId);
  const developerName =
    optToMaybe(game.developerDisplayName) ?? shortPrincipal(game.developer);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function confirmDelete() {
    if (!actor) return;
    setDeleting(true);
    setError(undefined);
    try {
      const res = await actor.deregisterGame(game.backendCanisterId);
      if ("err" in res) throw res.err;
      setConfirming(false);
      onDeleted();
    } catch (err) {
      setError(errMessage(err as Err));
    } finally {
      setDeleting(false);
    }
  }

  const bannerVar = banner
    ? ({ "--banner": `url(${banner})` } as React.CSSProperties)
    : undefined;

  return (
    <Fragment>
      <article
        className="card"
        style={{ "--i": index, ...bannerVar } as React.CSSProperties}
      >
        <span className="card-glow" aria-hidden="true" />
        <a
          className="card-link"
          href={gameUrl(game)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="card-media">
            <span className={`img${banner ? "" : " skeleton"}`} />
            <span className="card-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="card-play">
              Play <ArrowRight />
            </span>
          </span>
          <span className="card-body">
            <span className="card-title">{game.title}</span>
            <span className="card-meta">
              <span
                className="avatar small"
                style={avatarStyle(game.developer)}
              />
              <span className="name">{developerName}</span>
            </span>
            <span className="card-desc">{game.description}</span>
          </span>
        </a>
        {isOwner && (
          <span className="card-tools">
            <button
              type="button"
              className="icon-btn"
              onClick={onEdit}
              aria-label="Edit"
              title="Edit"
            >
              <Pencil />
            </button>
            <button
              type="button"
              className="icon-btn danger"
              onClick={() => {
                setError(undefined);
                setConfirming(true);
              }}
              aria-label="Deregister"
              title="Deregister"
            >
              <Trash />
            </button>
          </span>
        )}
      </article>

      {confirming && (
        <Modal onClose={() => setConfirming(false)} closable={!deleting}>
          <div className="modal-kicker">Deregister</div>
          <h2 className="modal-title">Remove “{game.title}”?</h2>
          <p className="modal-intro">
            This permanently removes the listing from this registry. The game's
            own canisters are untouched.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setConfirming(false)}
              disabled={deleting}
            >
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Removing…" : "Deregister"}
            </button>
          </div>
        </Modal>
      )}
    </Fragment>
  );
}

function shortPrincipal(p: Principal): string {
  const t = p.toText();
  return t.length <= 12 ? t : `${t.slice(0, 5)}…${t.slice(-3)}`;
}
