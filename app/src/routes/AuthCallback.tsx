import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { returnToFrom, userManager } from "../lib/oidc";

/**
 * Where the provider sends people back to, carrying the authorization code.
 *
 * This route is also the silent-renew target, loaded in a hidden iframe. That
 * case has to be handled first and must not navigate: an iframe that routed
 * itself to /sessions would quietly load the whole app again, every renewal,
 * inside a frame nobody can see.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.parent !== window) {
      void userManager.signinSilentCallback().catch(() => {
        /* The parent hears about this through the silent renew error event. */
      });
      return;
    }

    let live = true;
    void userManager
      .signinCallback()
      .then((signedIn) => {
        if (!live) return;
        /*
         * replace, so the back button does not return to a callback URL whose
         * code has already been spent and would fail a second time.
         */
        navigate(returnToFrom(signedIn?.state), { replace: true });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : "Sign-in did not complete.");
      });
    return () => {
      live = false;
    };
  }, [navigate]);

  if (error) {
    return (
      <main className="auth-screen">
        <h1>Sign-in did not complete</h1>
        <p className="form-error">{error}</p>
        <p>
          <Link to="/login">Try again</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <p>Completing sign-in…</p>
    </main>
  );
}
