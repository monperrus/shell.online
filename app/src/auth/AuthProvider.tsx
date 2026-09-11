import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { startSignIn, toAuthUser, userManager, type AuthUser } from "../lib/oidc";
import { setPasswordOwner } from "../lib/session-passwords";

interface AuthValue {
  user: AuthUser | null;
  /* True until the stored session has been read, so guards do not flash. */
  initializing: boolean;
  /** Leaves the app for the provider; resolves only if the redirect fails. */
  signIn: (returnTo?: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let live = true;

    const apply = (next: AuthUser | null) => {
      if (!live) return;
      /* Scope any stored session password to whoever is signed in now. */
      setPasswordOwner(next?.uid ?? "");
      setUser(next);
    };

    /*
     * The stored session is read once at startup; after that the manager's
     * events are the only thing that changes it. A renewal that fails ends
     * the session here rather than leaving a signed-in shell whose every
     * request is refused.
     */
    void userManager
      .getUser()
      .then((found) => apply(found && !found.expired ? toAuthUser(found) : null))
      .catch(() => apply(null))
      .finally(() => {
        if (live) setInitializing(false);
      });

    const onLoaded = (next: Parameters<Parameters<typeof userManager.events.addUserLoaded>[0]>[0]) =>
      apply(toAuthUser(next));
    const onUnloaded = () => apply(null);
    const onExpired = () => apply(null);
    const onRenewError = () => apply(null);

    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addAccessTokenExpired(onExpired);
    userManager.events.addSilentRenewError(onRenewError);

    return () => {
      live = false;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeAccessTokenExpired(onExpired);
      userManager.events.removeSilentRenewError(onRenewError);
    };
  }, []);

  const signIn = useCallback(async (returnTo?: string) => {
    await startSignIn({ returnTo });
  }, []);

  const signOutUser = useCallback(async () => {
    /*
     * Stored session passwords are keyed by account, so signing out does not
     * expose them to whoever signs in next. They are deliberately kept: they
     * are how this person reopens their own sessions, and how they share them
     * with colleagues who join later.
     *
     * Ending the provider's session too, not only this app's: a sign-out that
     * left the provider's cookie in place would sign the same person straight
     * back in on the next click, which does not look like signing out.
     */
    try {
      await userManager.signoutRedirect();
    } catch {
      /*
       * A provider with no end-session endpoint, or one that is unreachable,
       * must not leave someone stuck signed in. Dropping the local session is
       * the part this app can always do.
       */
      await userManager.removeUser();
    }
  }, []);

  const value = useMemo(
    () => ({ user, initializing, signIn, signOutUser }),
    [user, initializing, signIn, signOutUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider.");
  }
  return value;
}
