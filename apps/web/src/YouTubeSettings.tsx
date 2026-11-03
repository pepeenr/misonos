import { useEffect, useState } from "react";
import type { YouTubeImportStatus } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";

// Pairing with Downtify, which downloads pasted YouTube links into Navidrome. MiSonos
// keeps the app token Downtify hands out for a pairing code; it never sees a password.
export function YouTubeSettings({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<YouTubeImportStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void bridgeApi.youtubeStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const change = async (action: () => Promise<YouTubeImportStatus>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      setStatus(await action());
      setCode("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  };

  // Without a Downtify address there's nothing to pair with.
  if (!status?.available) return null;

  return (
    <section className="settings-card" aria-label="YouTube links">
      <h3>YouTube links</h3>
      <p className="settings-card-help">
        Paste a YouTube video or playlist link into the search box and press Enter. Downtify downloads the songs into
        Navidrome and adds them to the “{status.playlist}” playlist, and MiSonos plays them on the room you picked.
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
            In Downtify, open <strong>Settings → Apps</strong> and pair a new app. Enter the code it shows here within
            five minutes.
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
    </section>
  );
}
