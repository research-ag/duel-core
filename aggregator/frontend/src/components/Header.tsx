import type { Auth } from "../hooks/useAuth";
import { useProfile } from "../hooks/useProfile";
import { DisplayNameEditor } from "./DisplayNameEditor";

export function Header({
  auth,
  onRegister,
  onTutorial,
}: {
  auth: Auth;
  onRegister: () => void;
  onTutorial: () => void;
}) {
  const profile = useProfile(auth.actor, auth.principal);

  return (
    <header>
      <h1>
        <span>Duel Framework</span> Dashboard
      </h1>
      <div className="identity">
        <button onClick={onTutorial}>Build a new game</button>
        {auth.loading ? (
          <span className="name">…</span>
        ) : auth.isLoggedIn ? (
          <>
            <DisplayNameEditor displayName={profile.displayName} loading={profile.loading} save={profile.save} />
            <button className="primary" onClick={onRegister}>
              Register a game
            </button>
            <button onClick={() => void auth.logout()}>Log out</button>
          </>
        ) : (
          <button className="primary" onClick={() => void auth.login()}>
            Log in with Internet Identity
          </button>
        )}
      </div>
    </header>
  );
}
