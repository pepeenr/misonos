import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import type { NowPlaying, SonosSpotifyAccount } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { accountKey, isSpotifySongUri, loginChoices, loginLabel, spotifyLoginOfUri } from "./spotifyLogins.js";

interface SpotifyNowPlayingProps {
  groupId: string;
  nowPlaying: NowPlaying;
  /** The bridge changed what plays (another login, or radio): show it and reload the queue. */
  onPlayed: (nowPlaying: NowPlaying) => void;
}

// Under the song on the main screen while Spotify plays: which of the household's Spotify
// logins it plays on (Mia's, Pepe's), switchable, and Spotify radio from the song.
export function SpotifyNowPlaying({ groupId, nowPlaying, onPlayed }: SpotifyNowPlayingProps) {
  const current = spotifyLoginOfUri(nowPlaying.uri);
  const [accounts, setAccounts] = useState<SonosSpotifyAccount[] | null>(null);
  const [busy, setBusy] = useState<"login" | "radio" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridgeApi.spotifyAccounts()
      .then((view) => { if (!cancelled) setAccounts(view.accounts); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 3500 : 8000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  if (!current) return null;
  const choices = accounts ? loginChoices(accounts, current) : [];

  const switchLogin = async (key: string) => {
    const account = choices.find((choice) => accountKey(choice) === key);
    if (!account || key === accountKey(current)) return;
    setBusy("login");
    setStatus(null);
    try {
      const result = await bridgeApi.setSpotifyAccount(groupId, { sid: account.sid, sn: account.sn });
      onPlayed(result.nowPlaying);
      setStatus({ ok: true, message: `Spotify plays on ${loginLabel(account)} now.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't switch the Spotify login" });
    } finally {
      setBusy(null);
    }
  };

  const startRadio = async () => {
    setBusy("radio");
    setStatus(null);
    try {
      const result = await bridgeApi.startSpotifyRadio(groupId);
      onPlayed(result.nowPlaying);
      setStatus({ ok: true, message: `Playing ${result.artist.name} Radio.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't start Spotify radio" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="spotify-now-playing">
      <div className="spotify-now-playing-row">
        {choices.length > 1 ? (
          <label className="spotify-login" title="Which Spotify account plays the music. New Spotify songs play on it too.">
            <span>Spotify</span>
            <select
              aria-label="Spotify login"
              value={accountKey(current)}
              disabled={busy !== null}
              onChange={(event) => void switchLogin(event.target.value)}
            >
              {choices.map((account) => (
                <option key={accountKey(account)} value={accountKey(account)}>{loginLabel(account)}</option>
              ))}
            </select>
          </label>
        ) : choices.length === 1 ? (
          <span className="spotify-login">Spotify · {loginLabel(choices[0])}</span>
        ) : null}
        {isSpotifySongUri(nowPlaying.uri) ? (
          <button
            type="button"
            className="spotify-radio"
            title="Start Spotify radio from this song's artist (the queue stays)"
            disabled={busy !== null}
            aria-busy={busy === "radio" || undefined}
            onClick={() => void startRadio()}
          >
            <Radio size={15} aria-hidden="true" />
            {busy === "radio" ? "Starting…" : "Artist radio"}
          </button>
        ) : null}
        {busy === "login" ? <span className="spotify-now-playing-note">Moving the music…</span> : null}
      </div>
      {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}
    </div>
  );
}
