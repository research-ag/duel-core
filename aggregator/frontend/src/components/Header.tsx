import { useEffect, useState } from "react";

import type { Auth } from "../hooks/useAuth";
import { useProfile } from "../hooks/useProfile";
import { DisplayNameEditor } from "./DisplayNameEditor";
import { Bot, BrandMark, Hammer, Key, Plus } from "./Icons";

export function Header({
  auth,
  onRegister,
  onTutorial,
  onBotTutorial,
}: {
  auth: Auth;
  onRegister: () => void;
  onTutorial: () => void;
  onBotTutorial: () => void;
}) {
  const profile = useProfile(auth.actor, auth.principal);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`topbar${scrolled ? " scrolled" : ""}`}>
      <div className="wrap">
        <a className="brand" href="#top">
          <BrandMark />
          <span className="brand-word">
            Duel<em>.</em>
          </span>
          <span className="brand-tag">Arena</span>
        </a>
        <nav className="nav">
          <button
            type="button"
            className="btn ghost"
            onClick={onTutorial}
            aria-label="Build a game"
            title="Build a game"
          >
            <Hammer />
            <span className="label">Build a game</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={onBotTutorial}
            aria-label="Build a bot"
            title="Build a bot"
          >
            <Bot />
            <span className="label">Build a bot</span>
          </button>
          <span className="sep" />
          {auth.loading ? null : auth.isLoggedIn ? (
            <>
              <DisplayNameEditor
                principal={auth.principal}
                displayName={profile.displayName}
                loading={profile.loading}
                save={profile.save}
                logout={() => void auth.logout()}
              />
              <button
                type="button"
                className="btn primary"
                onClick={onRegister}
                aria-label="Register a game"
                title="Register a game"
              >
                <Plus />
                <span className="label">Register a game</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => void auth.login()}
              aria-label="Log in with Internet Identity"
              title="Log in with Internet Identity"
            >
              <Key />
              <span className="label">Log in with Internet Identity</span>
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
