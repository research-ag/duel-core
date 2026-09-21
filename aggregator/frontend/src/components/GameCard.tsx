import { Fragment, useState } from "react";
import type { Principal } from "@icp-sdk/core/principal";

import { useBanner } from "../hooks/useBanner";
import type { AggregatorActor, Err, GameView } from "../types";
import { errMessage, gameUrl, optToMaybe } from "../types";

export function GameCard({
  game,
  actor,
  isOwner,
  onEdit,
  onDeleted,
}: {
  game: GameView;
  actor: AggregatorActor | undefined;
  isOwner: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const banner = useBanner(actor, game.backendCanisterId);
  const developerName = optToMaybe(game.developerDisplayName) ?? shortPrincipal(game.developer);
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

  return (
    <Fragment>
      <a className="card" href={gameUrl(game)} target="_blank" rel="noreferrer">
        {isOwner && (
          <span className="card-actions">
            <button
              className="edit-btn"
              onClick={(e) => {
                e.preventDefault();
                onEdit();
              }}
            >
              Edit
            </button>
            <button
              className="delete-btn"
              onClick={(e) => {
                e.preventDefault();
                setError(undefined);
                setConfirming(true);
              }}
            >
              Delete
            </button>
          </span>
        )}
        <span className="banner" style={banner ? { backgroundImage: `url(${banner})` } : undefined} />
        <span className="body">
          <span className="title">{game.title}</span>
          <span className="developer">by {developerName}</span>
        </span>
        <span className="overlay">{game.description}</span>
      </a>

      {confirming && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Deregister "{game.title}"?</h2>
            <p>
              This permanently removes it from the registry. This does not affect the game's own canisters — only
              its listing here.
            </p>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? "Deregistering…" : "Deregister"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Fragment>
  );
}

function shortPrincipal(p: Principal): string {
  const t = p.toText();
  return t.length <= 12 ? t : `${t.slice(0, 5)}…${t.slice(-3)}`;
}
