import { useEffect, useState } from "react";
import { Radio, RadioTower } from "lucide-react";
import type { NowPlaying, SonosSpotifyAccount } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { canStartSongRadio, songRadioMessage } from "./songRadio.js";
import { accountKey, isSpotifySongUri, loginChoices, loginLabel, spotifyLoginOfUri } from "./spotifyLogins.js";

interface NowPlayingActionsProps {
  groupId: string;
  nowPlaying: NowPlaying;
  /** The bridge changed what plays (another login, or a radio): show it and reload the queue. */
  onPlayed: (nowPlaying: NowPlaying) => void;
}

// Under the song on the main screen: a radio of songs like it, and while Spotify plays,
// which of the household's Spotify logins it plays on (Mia's, Pepe's), switchable, and
// Spotify's own radio for the song's artist.
export function NowPlayingActions({ groupId, nowPlaying, onPlayed }: NowPlayingActionsProps) {
  const current = spotifyLoginOfUri(nowPlaying.uri);
  const [accounts, setAccounts] = useState<SonosSpotifyAccount[] | null>(null);
  const [busy, setBusy] = useState<"login" | "artist-radio" | "song-radio" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const spotify = !!current;

  useEffect(() => {
    if (!spotify) return undefined;
    let cancelled = false;
    void bridgeApi.spotifyAccounts()
      .then((view) => { if (!cancelled) setAccounts(view.accounts); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [spotify]);

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 5000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const songRadio = canStartSongRadio(nowPlaying);
  if (!current && !songRadio && !status) return null;
  const choices = current && accounts ? loginChoices(accounts, current) : [];

  const switchLogin = async (key: string) => {
    const account = choices.find((choice) => accountKey(choice) === key);
    if (!account || !current || key === accountKey(current)) return;
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

  const startArtistRadio = async () => {
    setBusy("artist-radio");
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

  const startSongRadio = async () => {
    setBusy("song-radio");
    setStatus(null);
    try {
      const result = await bridgeApi.startSongRadio(groupId);
      onPlayed(result.nowPlaying);
      setStatus({ ok: true, message: songRadioMessage(result) });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't start the song radio" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="now-playing-actions">
      <div className="now-playing-actions-row">
        {current && choices.length > 1 ? (
          <label className="spotify-login" title="Which Spotify account plays the music. New Spotify songs play on it too.">
            <span>Spotify</span>
            <select
              aria-label="Spotify login"
              value={accountKey(current)}
              disabled={busy !== null}
              onChange={(event) => {
                // Let go of the focus, so the arrow keys go back to the volume.
                event.currentTarget.blur();
                void switchLogin(event.target.value);
              }}
              // Arrows on a closed dropdown (Windows) pick the next login at once, which
              // moves the music to it: so they do nothing here. Alt+↓, F4 or Space open it.
              onKeyDown={(event) => {
                if (!event.altKey && /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(event.key)) event.preventDefault();
              }}
            >
              {choices.map((account) => (
                <option key={accountKey(account)} value={accountKey(account)}>{loginLabel(account)}</option>
              ))}
            </select>
          </label>
        ) : choices.length === 1 ? (
          <span className="spotify-login">Spotify · {loginLabel(choices[0])}</span>
        ) : null}
        {songRadio ? (
          <button
            type="button"
            className="now-playing-radio"
            title="Play songs like this one after it, in place of the rest of the queue"
            disabled={busy !== null}
            aria-busy={busy === "song-radio" || undefined}
            onClick={() => void startSongRadio()}
          >
            <RadioTower size={15} aria-hidden="true" />
            {busy === "song-radio" ? "Starting…" : "Song radio"}
          </button>
        ) : null}
        {isSpotifySongUri(nowPlaying.uri) ? (
          <button
            type="button"
            className="now-playing-radio"
            title="Start Spotify radio from this song's artist (the queue stays)"
            disabled={busy !== null}
            aria-busy={busy === "artist-radio" || undefined}
            onClick={() => void startArtistRadio()}
          >
            <Radio size={15} aria-hidden="true" />
            {busy === "artist-radio" ? "Starting…" : "Artist radio"}
          </button>
        ) : null}
        {busy === "login" ? <span className="now-playing-actions-note">Moving the music…</span> : null}
        {busy === "song-radio" ? <span className="now-playing-actions-note">Finding songs like it…</span> : null}
      </div>
      {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}
    </div>
  );
}
