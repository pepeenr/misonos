import { useCallback, useEffect, useRef, useState } from "react";
import type { SpotifyAccountsView } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { accountKey, loginChoices, loginLabel } from "./spotifyLogins.js";

/** The Sonos Spotify login new Spotify plays go to. Read by the bridge (SonosService.selectSpotifyAccount). */
export const SPOTIFY_ACCOUNT_PREF = "spotifySonosAccount";

/** A Sonos Spotify login, offered in Music as its own Spotify button ("Mia", "Pepe"). */
export interface SpotifyProfile {
  key: string;
  sid: number;
  sn: number;
  token: string;
  /** Short, for the button: the name, or "#3" for an unnamed login. */
  label: string;
  /** Long, for the tooltip and screen readers: "Spotify Mia", "Spotify login #3". */
  title: string;
}

/** The Spotify logins as Music's buttons, the one new plays go to, and a way to pick another. */
export function profilesOf(view: SpotifyAccountsView | null): SpotifyProfile[] {
  // A login pinned by MISONOS_SPOTIFY_SN wins over any choice, so there's nothing to pick.
  if (!view || view.selected?.origin === "env") return [];
  const profiles = loginChoices(view.accounts).map((account) => {
    const name = account.name?.trim();
    return {
      key: accountKey(account),
      sid: account.sid,
      sn: account.sn,
      token: account.token,
      label: name || `#${account.sn}`,
      title: name ? `Spotify ${name}` : loginLabel(account)
    };
  });
  return profiles.length > 1 ? profiles : [];
}

/**
 * The household's Spotify logins, once Music offers Spotify (`enabled`): loaded once in
 * the background, then again each time Music comes on screen (`visible`), so a name
 * given in Settings shows there. `loaded` turns true after the first answer (or failure).
 */
export function useSpotifyProfiles(enabled: boolean, visible: boolean) {
  const [view, setView] = useState<SpotifyAccountsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || (loadedRef.current && !visible)) return;
    let cancelled = false;
    bridgeApi.spotifyAccounts()
      .then((next) => { if (!cancelled) setView(next); })
      .catch(() => { /* Spotify then shows as one button, browsing the main account */ })
      .finally(() => {
        if (cancelled) return;
        loadedRef.current = true;
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [enabled, visible]);

  const choose = useCallback(async (profile: SpotifyProfile) => {
    await bridgeApi.setPreference(SPOTIFY_ACCOUNT_PREF, { sid: profile.sid, sn: profile.sn, token: profile.token });
    setView((current) => current ? { ...current, selected: { sid: profile.sid, sn: profile.sn, token: profile.token, origin: "preference" } } : current);
  }, []);

  return {
    profiles: profilesOf(view),
    selectedKey: view?.selected ? accountKey(view.selected) : undefined,
    loaded,
    choose
  };
}
