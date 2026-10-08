import { useMemo, useState } from "react";

import { BotTutorialWizard } from "./components/BotTutorialWizard";
import { FrontendTutorialWizard } from "./components/FrontendTutorialWizard";
import { GameInfoModal } from "./components/GameInfoModal";
import { GameFormModal } from "./components/GameFormModal";
import { GameGrid } from "./components/GameGrid";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { BrandMark } from "./components/Icons";
import { TutorialWizard } from "./components/TutorialWizard";
import { useAuth } from "./hooks/useAuth";
import { useGames } from "./hooks/useGames";
import type { GameView, Target } from "./types";
import { optToMaybe } from "./types";

/// Which modal (if any) is open: "register" for a fresh game, or an
/// existing `GameView` to edit — `undefined` means closed.
type Modal = "register" | GameView | undefined;

/// A frontend/bot guide: closed, open on its game picker, or open for
/// one game.
type Guide = "pick" | Target | undefined;

export function App() {
  const auth = useAuth();
  const { games, loading, reload } = useGames(auth.actor);
  const [modal, setModal] = useState<Modal>(undefined);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [frontendGuide, setFrontendGuide] = useState<Guide>(undefined);
  const [botGuide, setBotGuide] = useState<Guide>(undefined);
  const [infoFor, setInfoFor] = useState<GameView | undefined>(undefined);

  const developers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const g of games) {
      const id = g.developer.toText();
      if (!byId.has(id)) byId.set(id, optToMaybe(g.developerDisplayName) ?? id);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [games]);

  return (
    <div className="shell" id="top">
      <Header
        auth={auth}
        onRegister={() => setModal("register")}
        onTutorial={() => setTutorialOpen(true)}
        onBotTutorial={() => setBotGuide("pick")}
        onFrontendTutorial={() => setFrontendGuide("pick")}
      />
      <Hero
        games={games}
        actor={auth.actor}
        developers={developers.length}
        onBuild={() => setTutorialOpen(true)}
      />
      <GameGrid
        games={games}
        loading={loading}
        actor={auth.actor}
        ownPrincipal={auth.principal}
        developers={developers}
        onEdit={(game) => setModal(game)}
        onDeleted={reload}
        onInfo={(game) => setInfoFor(game)}
      />
      <footer className="footer">
        <div className="wrap">
          <span className="brand">
            <BrandMark />
            <span className="brand-word">
              Duel<em>.</em>
            </span>
          </span>
          <nav>
            <a
              href="https://github.com/research-ag/duel-core"
              target="_blank"
              rel="noreferrer"
            >
              research-ag/duel-core
            </a>
            <a
              href="https://github.com/research-ag/duel-core/blob/main/skills/duel-game-core/SKILL.md"
              target="_blank"
              rel="noreferrer"
            >
              Build a game
            </a>
            <a
              href="https://internetcomputer.org"
              target="_blank"
              rel="noreferrer"
            >
              Internet Computer
            </a>
          </nav>
        </div>
      </footer>
      {modal !== undefined && auth.actor && (
        <GameFormModal
          actor={auth.actor}
          existing={modal === "register" ? undefined : modal}
          onClose={() => setModal(undefined)}
          onSaved={reload}
        />
      )}
      {tutorialOpen && (
        <TutorialWizard
          isLoggedIn={auth.isLoggedIn}
          onClose={() => setTutorialOpen(false)}
          onRegister={() => {
            setTutorialOpen(false);
            setModal("register");
          }}
        />
      )}
      {frontendGuide !== undefined && (
        <FrontendTutorialWizard
          initial={frontendGuide === "pick" ? undefined : frontendGuide}
          games={games}
          loading={loading}
          actor={auth.actor}
          isLoggedIn={auth.isLoggedIn}
          onClose={() => setFrontendGuide(undefined)}
          onRegister={() => {
            setFrontendGuide(undefined);
            setModal("register");
          }}
        />
      )}
      {botGuide !== undefined && (
        <BotTutorialWizard
          initial={botGuide === "pick" ? undefined : botGuide}
          games={games}
          loading={loading}
          actor={auth.actor}
          onClose={() => setBotGuide(undefined)}
        />
      )}
      {infoFor !== undefined && (
        <GameInfoModal
          game={infoFor}
          games={games}
          onClose={() => setInfoFor(undefined)}
          onGuide={(purpose, target) => {
            setInfoFor(undefined);
            if (purpose === "bot") setBotGuide(target);
            else setFrontendGuide(target);
          }}
        />
      )}
    </div>
  );
}
