import { useState } from "react";

import { GameFormModal } from "./components/GameFormModal";
import { GameGrid } from "./components/GameGrid";
import { Header } from "./components/Header";
import { useAuth } from "./hooks/useAuth";
import { useGames } from "./hooks/useGames";
import type { GameView } from "./types";

/// Which modal (if any) is open: "register" for a fresh game, or an
/// existing `GameView` to edit — `undefined` means closed.
type Modal = "register" | GameView | undefined;

export function App() {
  const auth = useAuth();
  const { games, loading, reload } = useGames(auth.actor);
  const [modal, setModal] = useState<Modal>(undefined);

  return (
    <div className="wrap">
      <Header auth={auth} onRegister={() => setModal("register")} />
      <GameGrid
        games={games}
        loading={loading}
        actor={auth.actor}
        ownPrincipal={auth.principal}
        onEdit={(game) => setModal(game)}
        onDeleted={reload}
      />
      {modal !== undefined && auth.actor && (
        <GameFormModal
          actor={auth.actor}
          existing={modal === "register" ? undefined : modal}
          onClose={() => setModal(undefined)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
