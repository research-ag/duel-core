import { useMemo, useState } from "react";

import { BotTutorialWizard } from "./components/BotTutorialWizard";
import { FrontendTutorialWizard } from "./components/FrontendTutorialWizard";
import { GameFormModal } from "./components/GameFormModal";
import { GameGrid } from "./components/GameGrid";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { BrandMark } from "./components/Icons";
import { TutorialWizard } from "./components/TutorialWizard";
import { useAuth } from "./hooks/useAuth";
import { useGames } from "./hooks/useGames";
import type { GameView } from "./types";
import { optToMaybe } from "./types";

/// Which modal (if any) is open: "register" for a fresh game, or an
/// existing `GameView` to edit — `undefined` means closed.
type Modal = "register" | GameView | undefined;

export function App() {
  const auth = useAuth();
  const { games, loading, reload } = useGames(auth.actor);
  const [modal, setModal] = useState<Modal>(undefined);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [botTutorialOpen, setBotTutorialOpen] = useState(false);
  /// The frontend guide: closed, open for one game, or open with no game.
  const [frontendFor, setFrontendFor] = useState<GameView | "any" | undefined>(
    undefined
  );

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
        onBotTutorial={() => setBotTutorialOpen(true)}
        onFrontendTutorial={() => setFrontendFor("any")}
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
        onOwnFrontend={(game) => setFrontendFor(game)}
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
      {frontendFor !== undefined && (
        <FrontendTutorialWizard
          game={frontendFor === "any" ? undefined : frontendFor}
          isLoggedIn={auth.isLoggedIn}
          onClose={() => setFrontendFor(undefined)}
          onRegister={() => {
            setFrontendFor(undefined);
            setModal("register");
          }}
        />
      )}
      {botTutorialOpen && (
        <BotTutorialWizard onClose={() => setBotTutorialOpen(false)} />
      )}
    </div>
  );
}
