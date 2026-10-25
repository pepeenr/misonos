import { useCallback, useEffect, useState } from "react";
import type { SpotifyAccountsView, SpotifyAuthStatus, SpotifyClientStatus } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { apiUrl } from "./servers.js";

const CALLBACK_PATH = "/api/sources/spotify/auth/callback";
const CREATE_APP_URL = "https://developer.spotify.com/dashboard/create";
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

function shortClientId(clientId: string): string {
  return `${clientId.slice(0, 4)}…${clientId.slice(-4)}`;
}

// The value as selectable code, plus a Copy button where the clipboard is available
// (it needs a secure context, i.e. https).
function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <code style={{ userSelect: "all", wordBreak: "break-all" }}>{value}</code>
      {canCopy ? (
        <button
          type="button"
          style={{ padding: "2px 8px", fontSize: "0.78rem" }}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      ) : null}
    </span>
  );
}

export function SpotifySettings({ onSourcesChanged }: { onSourcesChanged?: () => void }) {
  const [status, setStatus] = useState<SpotifyAuthStatus | null>(null);
  const [client, setClient] = useState<SpotifyClientStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [accounts, setAccounts] = useState<SpotifyAccountsView | null>(null);
  const [editing, setEditing] = useState(false);
  const [clientIdInput, setClientIdInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextClient] = await Promise.all([bridgeApi.spotifyAuthStatus(), bridgeApi.spotifyClient()]);
      setStatus(nextStatus);
      setClient(nextClient);
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

  // Run a change, then re-read everything it can affect: the Client ID decides
  // whether Spotify is listed at all, and a new one signs out.
  const change = useCallback(async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      onSourcesChanged?.();
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "spotify" } }));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, onSourcesChanged]);

  const saveClientId = useCallback(async () => {
    if (await change(() => bridgeApi.saveSpotifyClient(clientIdInput), "Couldn't save the Client ID")) {
      setEditing(false);
      setClientIdInput("");
    }
  }, [change, clientIdInput]);

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

  if (unavailable || !status || !client) return null;

  const redirectUri = status.redirectUri ?? callbackUrl();
  // Shown while setting up too, so a LAN address isn't registered as the redirect URI.
  const httpsWarning = acceptedBySpotify(redirectUri) ? null : (
    <p className="settings-card-error">
      Spotify accepts only https redirect URIs (or http://127.0.0.1). Open MiSonos over https to set up and connect.
    </p>
  );
  const hasClientId = client.source !== "none";
  const selected = accounts?.selected;
  const pinnedByEnv = selected?.origin === "env";

  return (
    <section className="settings-card">
      <h3>Spotify</h3>
      <p className="settings-card-help">
        Browse and search your Spotify library here. Sonos plays it with a Spotify account linked in the Sonos app,
        so it plays on speakers only, not on this device.
      </p>
      {error ? <p className="settings-card-error">{error}</p> : null}

      <h4 className="settings-card-subhead">1. Spotify app</h4>
      {hasClientId && !editing ? (
        <div className="source-login">
          <div className="settings-card-row">
            <span className="source-login-summary">
              Client ID {shortClientId(client.clientId ?? "")}
              {client.source === "saved" ? " (saved here)" : " (from MISONOS_SPOTIFY_CLIENT_ID)"}
            </span>
            <span className="source-login-actions">
              {client.source === "saved" ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  title={client.envConfigured ? "Go back to the Client ID from the env var" : "Hide Spotify until a Client ID is saved again"}
                  onClick={() => void change(() => bridgeApi.clearSpotifyClient(), "Couldn't remove the Client ID")}
                >
                  {client.envConfigured ? "Use env Client ID" : "Remove"}
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => { setEditing(true); setError(""); }}>Change</button>
            </span>
          </div>
        </div>
      ) : (
        <>
          <p className="settings-card-help">
            MiSonos reads your library through a small app of your own on Spotify's developer site. Spotify requires that
            you create it yourself, once (about two minutes):
          </p>
          <ol className="settings-card-help" style={{ paddingLeft: "1.2rem", display: "grid", gap: 6 }}>
            <li>
              Open <a href={CREATE_APP_URL} target="_blank" rel="noreferrer">Create app</a> and sign in with your
              Spotify account. It needs Premium.
            </li>
            <li>
              Name it anything (e.g. MiSonos), add any description, and paste this as the <strong>Redirect URI</strong>:{" "}
              <CopyableCode value={redirectUri} />
            </li>
            <li>Tick <strong>Web API</strong>, accept the terms and press <strong>Save</strong>.</li>
            <li>Copy the <strong>Client ID</strong> shown on the app's page and paste it here.</li>
          </ol>
          {httpsWarning}
          <form
            className="custom-service-controls"
            onSubmit={(event) => { event.preventDefault(); void saveClientId(); }}
          >
            <label>
              <span>Client ID</span>
              <input
                value={clientIdInput}
                onChange={(event) => setClientIdInput(event.target.value)}
                placeholder="32 letters and digits"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <span className="source-login-actions">
              <button type="submit" disabled={busy || !clientIdInput.trim()}>Save</button>
              {editing ? (
                <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
              ) : null}
            </span>
          </form>
        </>
      )}

      {status.configured ? (
        <>
          <h4 className="settings-card-subhead">2. Your Spotify account</h4>
          {status.signedIn ? (
            <div className="settings-card-row">
              <span>Connected as {status.user?.displayName || status.user?.id || "your Spotify account"}.</span>
              <button type="button" disabled={busy} onClick={() => void change(() => bridgeApi.spotifyLogout(), "Couldn't disconnect")}>Disconnect</button>
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
                One sign-in serves every device that uses this MiSonos. If Spotify reports an invalid redirect URI, add this
                one to your app: <CopyableCode value={redirectUri} />
              </p>
              {httpsWarning}
            </>
          )}
        </>
      ) : null}

      {status.configured && accounts ? (
        <>
          <h4 className="settings-card-subhead">3. Sonos playback login</h4>
          {accounts.accounts.length === 0 && !selected ? (
            <>
              <p className="settings-card-help">
                No Spotify items in Sonos Favorites or the queues yet. In the Sonos app, add any Spotify song to your
                Sonos Favorites so MiSonos can tell which linked Spotify login to play with.
              </p>
              <div className="settings-card-row">
                <button type="button" disabled={busy} onClick={() => void loadAccounts(true)}>Look again</button>
              </div>
            </>
          ) : (
            <>
              <p className="settings-card-help">
                {pinnedByEnv
                  ? `Set to Spotify login #${selected.sn} by MISONOS_SPOTIFY_SN.`
                  : accounts.accounts.length > 1
                    ? `${accounts.accounts.length} Spotify logins are linked in the Sonos app. Sonos only numbers them, without names, so each is listed with the Sonos Favorites (or queued songs) that use it. Pick the one whose favorites are yours: songs play on that Spotify account.`
                    : "Songs play on the Spotify login linked in the Sonos app."}
              </p>
              <div className="settings-card-row settings-card-column" role="radiogroup" aria-label="Sonos Spotify login">
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
                        Spotify login #{account.sn}
                        {checked && selected?.origin === "auto" ? " (picked automatically: most favorites)" : ""}
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
