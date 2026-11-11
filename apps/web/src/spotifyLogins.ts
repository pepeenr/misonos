import type { SonosSpotifyAccount } from "@misonos/sonos-protocol";

// The Sonos side of Spotify on the main screen: which of the household's Spotify logins
// the music plays on, and which ones to offer.

/** Shared with the bridge, which adds the names to /api/spotify/accounts. Keyed "sid:sn". */
export const SPOTIFY_ACCOUNT_NAMES_PREF = "spotifyAccountNames";

export function accountKey(account: { sid: number; sn: number }): string {
  return `${account.sid}:${account.sn}`;
}

/** Which login (sid, sn) a now-playing URI plays Spotify on: a song, or Spotify radio. */
export function spotifyLoginOfUri(uri: string | undefined): { sid: number; sn: number } | undefined {
  if (!uri || !(/^x-sonos-spotify:/i.test(uri) || /^x-sonosapi-radio:spotify%3a/i.test(uri))) return undefined;
  const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  const sid = Number.parseInt(params.get("sid") ?? "", 10);
  const sn = Number.parseInt(params.get("sn") ?? "", 10);
  return Number.isInteger(sid) && Number.isInteger(sn) ? { sid, sn } : undefined;
}

/** A Spotify song (not radio) is playing, so radio can start from it. */
export function isSpotifySongUri(uri: string | undefined): boolean {
  return !!uri && /^x-sonos-spotify:spotify%3atrack%3a/i.test(uri);
}

export function loginLabel(account: { sn: number; name?: string }): string {
  return account.name?.trim() || `Spotify login #${account.sn}`;
}

/**
 * The logins to choose between: the named ones once any has a name (the others are old
 * or unused), else all. The one playing now is always there.
 */
export function loginChoices(accounts: SonosSpotifyAccount[], current?: { sid: number; sn: number }): SonosSpotifyAccount[] {
  const named = accounts.filter((account) => account.name?.trim());
  const choices = named.length > 0 ? named : [...accounts];
  if (current && !choices.some((account) => accountKey(account) === accountKey(current))) {
    const playing = accounts.find((account) => accountKey(account) === accountKey(current));
    choices.push(playing ?? { ...current, token: "", seenOn: [], uses: 0 });
  }
  return choices;
}
