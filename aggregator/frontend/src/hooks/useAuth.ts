// This tab's Internet Identity session. Builds an actor for whichever
// identity is active — anonymous while nobody's logged in (still usable
// for every public query: listGames/getGame/getBanner/getProfile), the
// real principal once a login resolves — and exposes login()/logout(),
// which reload the page on success (the simplest way for a freshly
// authenticated identity to take effect everywhere at once; the same
// approach `@research-ag/duel-game-core/identity.ts` uses for the same reason).

import { useCallback, useEffect, useState } from "react";
import { AuthClient } from "@icp-sdk/auth/client";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";

import { createActor } from "../api";
import type { AggregatorActor } from "../types";

// A popup, not a tab: a tab hides this page, Chrome then throttles its
// timers, and the signer's 2 s heartbeat closes Internet Identity
// before it answers.
const POPUP_FEATURES = "toolbar=0,location=0,menubar=0,width=500,height=700";

export interface Auth {
  loading: boolean;
  isLoggedIn: boolean;
  principal?: Principal;
  /// The login's identity, for calls to other canisters (wallet.ts).
  identity?: Identity;
  actor?: AggregatorActor;
  /// Why the last login failed, until the next attempt or a dismiss.
  loginError?: string;
  login(): Promise<void>;
  logout(): Promise<void>;
  dismissLoginError(): void;
}

export function useAuth(): Auth {
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [principal, setPrincipal] = useState<Principal | undefined>(undefined);
  const [identity, setIdentity] = useState<Identity | undefined>(undefined);
  const [actor, setActor] = useState<AggregatorActor | undefined>(undefined);
  const [authClient, setAuthClient] = useState<AuthClient | undefined>(
    undefined
  );
  const [loginError, setLoginError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const client = new AuthClient({ windowOpenerFeatures: POPUP_FEATURES });
      if (cancelled) return;
      const loggedIn = client.isAuthenticated();
      const identity = loggedIn ? await client.getIdentity() : undefined;
      const builtActor = await createActor(identity);
      if (cancelled) return;
      setAuthClient(client);
      setIsLoggedIn(loggedIn);
      setPrincipal(identity?.getPrincipal());
      setIdentity(identity);
      setActor(builtActor);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async () => {
    if (!authClient) return;
    setLoginError(undefined);
    try {
      await authClient.signIn();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
      return;
    }
    location.reload();
  }, [authClient]);

  const logout = useCallback(async () => {
    if (!authClient) return;
    await authClient.signOut();
    location.reload();
  }, [authClient]);

  const dismissLoginError = useCallback(() => setLoginError(undefined), []);

  return {
    loading,
    isLoggedIn,
    principal,
    identity,
    actor,
    loginError,
    login,
    logout,
    dismissLoginError,
  };
}
