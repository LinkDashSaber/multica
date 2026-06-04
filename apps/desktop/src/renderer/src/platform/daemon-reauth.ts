import { useAuthStore } from "@multica/core/auth";

/**
 * Re-establish the local daemon's credentials after it failed to authenticate
 * (daemon state "auth_expired", surfaced by daemon-manager's token probe — see
 * #3512).
 *
 * The desktop owns the daemon's PAT: it mints one from the user's session token
 * and caches it per profile. A stale/revoked cached PAT is the common cause of
 * the failure (and merely restarting the app reuses the same bad PAT), so we
 * drop the cached token and mint a fresh one from the current session, then
 * restart the daemon so it loads the new credential.
 *
 * If minting fails the session token itself is dead — fall back to the standard
 * re-login flow (the same `logout()` the API client uses on a 401), which lands
 * the user on the login page and re-mints a PAT on the next sign-in.
 */
export async function reauthenticateDaemon(): Promise<void> {
  const user = useAuthStore.getState().user;
  const token = localStorage.getItem("multica_token");
  if (!user || !token) {
    useAuthStore.getState().logout();
    return;
  }
  try {
    await window.daemonAPI.clearToken();
    await window.daemonAPI.syncToken(token, user.id);
    await window.daemonAPI.restart();
  } catch {
    // Session token is also invalid (mint returned 401) — full re-login.
    useAuthStore.getState().logout();
  }
}
