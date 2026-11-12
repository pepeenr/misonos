import { useCallback, useEffect, useState } from "react";
import type { YouTubeImportStatus } from "@misonos/sonos-protocol";
import { SettingsCard } from "./SettingsSection.js";
import { bridgeApi } from "./api.js";

// Everything YouTube in one Settings section: the YouTube Music source's library
// (your cookies), and pasted YouTube links (played through that source, or downloaded
// into Navidrome by Downtify). Both depend on YouTube Music being on as a source.
export function YouTubeSettings({ sourcesVersion, onChanged }: { sourcesVersion: number; onChanged: () => void }) {
  // undefined while loading; null when the source list couldn't be read.
  const [youtubeMusic, setYoutubeMusic] = useState<{ enabled: boolean; available: boolean } | null | undefined>(undefined);
  const [links, setLinks] = useState<YouTubeImportStatus | null>(null);

  useEffect(() => {
    void bridgeApi.sourceSettings()
      .then((settings) => setYoutubeMusic(settings.find((setting) => setting.id === "youtube-music") ?? null))
      .catch(() => setYoutubeMusic(null));
    void bridgeApi.youtubeStatus().then(setLinks).catch(() => setLinks(null));
  }, [sourcesVersion]);

  // No YouTube Music service and no Downtify: nothing YouTube in this MiSonos.
  if (youtubeMusic === undefined || (!youtubeMusic && !links?.available)) return null;

  const on = Boolean(youtubeMusic?.enabled && youtubeMusic.available);
  return (
    <SettingsCard id="youtube" title="YouTube">
      {!on ? (
        <p className="settings-card-help">
          {youtubeMusic && !youtubeMusic.available
            ? "The YouTube Music service isn't running, so YouTube can't be browsed and pasted YouTube links aren't offered."
            : "YouTube Music is off. Turn it on under Custom Music Services to browse it and to paste YouTube links into the search box."}
        </p>
      ) : null}

      {on ? (
        <>
          <h4 className="settings-card-subhead">YouTube Music library</h4>
          <YouTubeMusicLibrary />
        </>
      ) : null}

      {links?.available ? (
        <>
          <h4 className="settings-card-subhead">YouTube links</h4>
          <YouTubeLinks status={links} disabled={!on} onStatus={setLinks} onChanged={onChanged} />
        </>
      ) : null}
    </SettingsCard>
  );
}

/** Your YouTube Music Library and My Supermix, through the cookies of a signed-in browser. */
function YouTubeMusicLibrary() {
  type Status = { cookieAuth?: "signed-in" | "signed-out" };
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  const cookieSignedIn = status?.cookieAuth === "signed-in";

  const saveCookies = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await bridgeApi.sourceAuthSetCookies("youtube-music", paste));
      setPaste("");
      setShowPaste(false);
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save cookies");
    } finally {
      setBusy(false);
    }
  }, [paste]);

  const clearCookies = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await bridgeApi.sourceAuthClearCookies("youtube-music"));
      window.dispatchEvent(new CustomEvent("misonos:source-auth-changed", { detail: { sourceId: "youtube-music" } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't clear cookies");
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridgeApi.sourceAuthStatus("youtube-music"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read auth status");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read status when auth changes elsewhere (e.g. the browser detected the
  // backend dropping expired cookies), so the label stays accurate.
  useEffect(() => {
    const onAuthChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string }>).detail;
      if (!detail?.sourceId || detail.sourceId === "youtube-music") void refresh();
    };
    window.addEventListener("misonos:source-auth-changed", onAuthChanged);
    return () => window.removeEventListener("misonos:source-auth-changed", onAuthChanged);
  }, [refresh]);

  return (
    <>
      <p className="settings-card-help">
        Search and browse work without signing in. Your Library and My Supermix need your YouTube&nbsp;Music cookies:
        on a computer, open <a href="https://music.youtube.com" target="_blank" rel="noreferrer">music.youtube.com</a>{" "}
        (signed in) → DevTools → <strong>Network</strong> → click any <code>/browse</code> request → right-click →
        <strong> Copy → Copy as cURL</strong>, then paste it below.
      </p>
      {error ? <p className="settings-card-error">{error}</p> : null}
      {cookieSignedIn ? (
        <div className="settings-card-row">
          <span>Library connected.</span>
          <button type="button" disabled={busy} onClick={() => void clearCookies()}>Disconnect</button>
        </div>
      ) : showPaste ? (
        <div className="settings-card-row settings-card-column">
          <textarea
            className="settings-card-textarea"
            value={paste}
            disabled={busy}
            placeholder="Paste the full 'Copy as cURL' here…"
            onChange={(event) => setPaste(event.target.value)}
            rows={4}
          />
          <div className="settings-card-row">
            <button type="button" disabled={busy || !paste.trim()} onClick={() => void saveCookies()}>Save cookies</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setShowPaste(false); setPaste(""); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="settings-card-row">
          <span>Library not connected.</span>
          <button type="button" disabled={busy} onClick={() => setShowPaste(true)}>Paste cookies</button>
        </div>
      )}
    </>
  );
}

// Pairing with Downtify, which downloads pasted YouTube links into Navidrome. MiSonos
// keeps the app token Downtify hands out for a pairing code; it never sees a password.
function YouTubeLinks({ status, disabled, onStatus, onChanged }: {
  status: YouTubeImportStatus;
  /** YouTube Music is off: the search box doesn't take links, but pairing still works. */
  disabled: boolean;
  onStatus: (status: YouTubeImportStatus) => void;
  onChanged: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const change = async (action: () => Promise<YouTubeImportStatus>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      onStatus(await action());
      setCode("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="settings-card-help">
        {disabled ? "While YouTube Music is on, paste" : "Paste"} a YouTube video or playlist link into the search box:
        play it straight from YouTube, or have Downtify download the songs into Navidrome&rsquo;s
        &ldquo;{status.playlist}&rdquo; playlist.
      </p>
      {error ? <p className="settings-card-error">{error}</p> : null}
      {status.paired ? (
        <div className="source-login">
          <div className="settings-card-row">
            <span className="source-login-summary">
              Paired with Downtify{status.username ? ` as ${status.username}` : ""}.
            </span>
            <span className="source-login-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                title="Forget the token here. Remove MiSonos under Settings → Apps in Downtify to revoke it there too."
                onClick={() => void change(() => bridgeApi.unpairYouTube(), "Couldn't unpair")}
              >
                Unpair
              </button>
            </span>
          </div>
        </div>
      ) : (
        <>
          <p className="settings-card-help">
            To download, pair with Downtify: open <strong>Settings → Apps</strong> there and pair a new app. Enter the
            code it shows here within five minutes.
          </p>
          <form
            className="custom-service-controls"
            onSubmit={(event) => { event.preventDefault(); void change(() => bridgeApi.pairYouTube(code), "Couldn't pair"); }}
          >
            <label>
              <span>Pairing code</span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                spellCheck={false}
                required
              />
            </label>
            <span className="source-login-actions">
              <button type="submit" disabled={busy || !code.trim()}>{busy ? "Pairing…" : "Pair"}</button>
            </span>
          </form>
        </>
      )}
    </>
  );
}
