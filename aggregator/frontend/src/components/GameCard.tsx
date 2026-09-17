import type { Principal } from "@icp-sdk/core/principal";

import { useBanner } from "../hooks/useBanner";
import type { AggregatorActor, GameView } from "../types";
import { gameUrl, optToMaybe } from "../types";

export function GameCard({
  game,
  actor,
  isOwner,
  onEdit,
}: {
  game: GameView;
  actor: AggregatorActor | undefined;
  isOwner: boolean;
  onEdit: () => void;
}) {
  const banner = useBanner(actor, game.backendCanisterId);
  const developerName = optToMaybe(game.developerDisplayName) ?? shortPrincipal(game.developer);

  return (
    <a className="card" href={gameUrl(game)} target="_blank" rel="noreferrer">
      {isOwner && (
        <button
          className="edit-btn"
          onClick={(e) => {
            e.preventDefault();
            onEdit();
          }}
        >
          Edit
        </button>
      )}
      <span className="banner" style={banner ? { backgroundImage: `url(${banner})` } : undefined} />
      <span className="body">
        <span className="title">{game.title}</span>
        <span className="developer">by {developerName}</span>
      </span>
      <span className="overlay">{game.description}</span>
    </a>
  );
}

function shortPrincipal(p: Principal): string {
  const t = p.toText();
  return t.length <= 12 ? t : `${t.slice(0, 5)}…${t.slice(-3)}`;
}
