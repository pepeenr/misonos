import { useCallback, useEffect, useState } from "react";
import type { SpotifyAccountsView, SpotifyAuthStatus } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { apiUrl } from "./servers.js";

const CALLBACK_PATH = "/api/sources/spotify/auth/callback";
// Read by the bridge when it queues Spotify items (see SonosService.selectSpotifyAccount).
const ACCOUNT_PREF_KEY = "spotifySonosAccount";

// The bridge's OAuth callback as this browser reaches it, which is what Spotify
// redirects back to.
function callbackUrl(): string {
  return new URL(apiUrl(CALLBACK_PATH), window.location.href).href;
}

// Spotify takes plain-http redirect URIs only for loopback addresses.
function acceptedBySpotify(uri: string): boolean {
  const url = new URL(uri);
  return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function SpotifySettings() {
  const [status, setStatus] = useState<SpotifyAuthStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [accounts, setAccounts] = useState<SpotifyAccountsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridgeApi.spotifyAuthStatus());
      setUnavailable(false);
    } catch {
      // No Spotify service in this stack: leave the card out.
      setUnavailable(true);
    }
  }, []);

  const loadAccounts = useCallback(async (force = false) => {
    try {
      setAccounts(await bridgeApi.spotifyAccounts(force));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the Sonos Spotify accounts");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const configured = status?.configured ?? false;
  useEffect(() => {
    if (configured) void loadAccounts();
  }, [configured, loadAccounts]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await bridgeApi.spotifyLogout();
      await refresh();
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "spotify" } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const chooseAccount = useCallback(async (account: { sid: number; sn: number; token: string }) => {
    setBusy(true);
    setError("");
    try {
      await bridgeApi.setPreference(ACCOUNT_PREF_KEY, { sid: account.sid, sn: account.sn, token: account.token });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the account");
    } finally {
      setBusy(false);
    }
  }, [loadAccounts]);

  if (unavailable || !status) return null;

  const redirectUri = status.redirectUri ?? callbackUrl();
  const redirectCode = <code style={{ userSelect: "all", wordBreak: "break-all" }}>{redirectUri}</code>;
  const selected = accounts?.selected;
  const pinnedByEnv = selected?.origin === "env";

  return (
    <section className="settings-card">
      <h3>Spotify</h3>
      <p className="settings-card-help">
        Browse and search your Spotify library here. Sonos plays it with the Spotify account linked in the Sonos app,
        so it plays on speakers only, not on this device.
      </p>
      {error ? <p className="settings-card-error">{error}</p> : null}
      {!status.configured ? (
        <>
          <h4 className="settings-card-subhead">Set up</h4>
          <ol className="settings-card-help" style={{ paddingLeft: "1.2rem" }}>
            <li>
              Create an app on the{" "}
              <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify developer dashboard</a>{" "}
              and tick <strong>Web API</strong>. The app's owner needs Spotify Premium.
            </li>
            <li>Add this Redirect URI to the app: {redirectCode}</li>
            <li>Set <code>MISONOS_SPOTIFY_CLIENT_ID</code> on the spotify service to the app's Client ID, then restart it.</li>
          </ol>
        </>
      ) : status.signedIn ? (
        <div className="settings-card-row">
          <span>Connected as {status.user?.displayName || status.user?.id || "your Spotify account"}.</span>
          <button type="button" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
        </div>
      ) : (
        <>
          <div className="settings-card-row">
            <span>Not connected.</span>
            <button type="button" disabled={busy} onClick={() => window.location.assign(apiUrl(`/api/sources/spotify/auth/login?redirect_uri=${encodeURIComponent(redirectUri)}`))}>
              Connect Spotify
            </button>
          </div>
          <p className="settings-card-help">
            One sign-in serves every device that uses this MiSonos. Your Spotify app must list this Redirect URI: {redirectCode}
          </p>
          {acceptedBySpotify(redirectUri) ? null : (
            <p className="settings-card-error">
              Spotify accepts only https redirect URIs (or http://127.0.0.1). Open MiSonos over https to connect.
            </p>
          )}
        </>
      )}
      {status.configured && accounts ? (
        <>
          <h4 className="settings-card-subhead">Sonos account</h4>
          {accounts.accounts.length === 0 && !selected ? (
            <>
              <p className="settings-card-help">
                No Spotify items in Sonos Favorites or the queues yet. In the Sonos app, add any Spotify song to your
                Sonos Favorites so MiSonos can tell which linked account to play with.
              </p>
              <div className="settings-card-row">
                <button type="button" disabled={busy} onClick={() => void loadAccounts(true)}>Look again</button>
              </div>
            </>
          ) : (
            <>
              <p className="settings-card-help">
                {pinnedByEnv
                  ? `Set to account ${selected.sn} by MISONOS_SPOTIFY_SN.`
                  : accounts.accounts.length > 1
                    ? "Several Spotify accounts are linked on this Sonos system. Pick the one you connected above."
                    : "Spotify items play with this linked account."}
              </p>
              <div className="settings-card-row settings-card-column" role="radiogroup" aria-label="Sonos Spotify account">
                {accounts.accounts.map((account) => {
                  const checked = selected?.sid === account.sid && selected.sn === account.sn;
                  return (
                    <label key={`${account.sid}:${account.sn}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type="radio"
                        name="spotify-sonos-account"
                        checked={checked}
                        disabled={busy || pinnedByEnv}
                        onChange={() => void chooseAccount(account)}
                      />
                      <span>
                        Account {account.sn}
                        {checked && selected?.origin === "auto" ? " (picked automatically)" : ""}
                        {account.seenOn.length ? <small className="settings-card-help" style={{ display: "block" }}>Used by {account.seenOn.join(", ")}</small> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
