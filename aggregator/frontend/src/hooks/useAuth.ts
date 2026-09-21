// This tab's Internet Identity session. Builds an actor for whichever
// identity is active — anonymous while nobody's logged in (still usable
// for every public query: listGames/getGame/getBanner/getProfile), the
// real principal once a login resolves — and exposes login()/logout(),
// which reload the page on success (the simplest way for a freshly
// authenticated identity to take effect everywhere at once; the same
// approach `duel-game-core/identity.ts` uses for the same reason).

import { useCallback, useEffect, useState } from "react";
import { AuthClient } from "@icp-sdk/auth/client";
import type { Principal } from "@icp-sdk/core/principal";

import { createActor } from "../api";
import type { AggregatorActor } from "../types";

export interface Auth {
  loading: boolean;
  isLoggedIn: boolean;
  principal?: Principal;
  actor?: AggregatorActor;
  login(): Promise<void>;
  logout(): Promise<void>;
}

export function useAuth(): Auth {
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [principal, setPrincipal] = useState<Principal | undefined>(undefined);
  const [actor, setActor] = useState<AggregatorActor | undefined>(undefined);
  const [authClient, setAuthClient] = useState<AuthClient | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const client = new AuthClient();
      if (cancelled) return;
      const loggedIn = client.isAuthenticated();
      const identity = loggedIn ? await client.getIdentity() : undefined;
      const builtActor = await createActor(identity);
      if (cancelled) return;
      setAuthClient(client);
      setIsLoggedIn(loggedIn);
      setPrincipal(identity?.getPrincipal());
      setActor(builtActor);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async () => {
    if (!authClient) return;
    await authClient.signIn();
    location.reload();
  }, [authClient]);

  const logout = useCallback(async () => {
    if (!authClient) return;
    await authClient.signOut();
    location.reload();
  }, [authClient]);

  return { loading, isLoggedIn, principal, actor, login, logout };
}
