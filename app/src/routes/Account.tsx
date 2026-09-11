import { SealCheck, SignOut, Warning } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";

export function Account() {
  usePageTitle("Account");
  const { user, signOutUser } = useAuth();

  if (!user) return null;

  /*
   * The host of the issuer, which is as much as this app knows about where
   * the account lives. It holds no password and cannot change one.
   */
  const issuer = import.meta.env.VITE_OIDC_ISSUER ?? "";
  const providerLabel = issuer ? new URL(issuer).host : "an identity provider";

  return (
    <AppShell title="Account">

      <dl className="account-rows">
        <div className="account-row">
          <dt>Name</dt>
          <dd>{user.displayName || "Not set"}</dd>
        </div>
        <div className="account-row">
          <dt>Email</dt>
          <dd>
            {user.email}
            {user.emailVerified ? (
              <span className="account-verified">
                <SealCheck size={13} weight="fill" /> verified
              </span>
            ) : (
              <span className="account-unverified">
                <Warning size={13} weight="fill" /> not verified
              </span>
            )}
          </dd>
        </div>
        <div className="account-row">
          <dt>Signed in with</dt>
          <dd>{providerLabel}</dd>
        </div>
        <div className="account-row">
          <dt>User id</dt>
          <dd>{user.uid}</dd>
        </div>
      </dl>

      {/*
        Sign out lives here as well as in the sidebar. On a phone the sidebar
        becomes a bar of destinations with no room for the account row, and
        this is the destination that row would have led to, so leaving it out
        would strand anybody who opened the app from a home screen.
      */}
      <p className="account-note">
        Your name, email address and password belong to {providerLabel}. Change
        them, or verify your address, there — this app only reads them.
      </p>

      <div className="account-actions">
        <Button type="button" variant="ghost" onClick={() => void signOutUser()}>
          <SignOut size={15} />
          Sign out
        </Button>
      </div>
    </AppShell>
  );
}
