import { allTagBlocks, escapeXml, tagText } from "@misonos/sonos-protocol";
import type { SonosSpotifyAccount, SourceTrackInfo } from "@misonos/sonos-protocol";

export type { SonosSpotifyAccount };

// Spotify tracks can't be streamed through the bridge. They play through the Spotify
// account linked to the household in the Sonos app, addressed by its service id (sid,
// 9 in most regions), the account's serial number (sn) and the account token Sonos
// pairs with it in item metadata. None of that is in /status/accounts on current
// firmware, so it's read off Spotify items the speakers already hold: Sonos Favorites
// and queues.

export const SPOTIFY_SOURCE_ID = "spotify";

const SPOTIFY_URI = /^spotify:(track|album|playlist):[A-Za-z0-9]+$/;
const SEEN_ON_MAX = 3;

export function isSpotifyUri(value: string | undefined): boolean {
  return !!value && SPOTIFY_URI.test(value);
}

// The token Sonos uses when an item doesn't carry one: service type sid*256+7.
export function defaultSpotifyToken(sid: number): string {
  const serviceType = sid * 256 + 7;
  return `SA_RINCON${serviceType}_X_#Svc${serviceType}-0-Token`;
}

// Every Spotify account referenced by a ContentDirectory listing (FV:2 favorites,
// Q:0 queues). The listing must be the Result as returned by the SOAP call: outer
// items are markup, a favorite's own metadata (r:resMD) is still escaped inside it.
export function spotifyAccountsInDidl(didl: string | undefined): SonosSpotifyAccount[] {
  if (!didl) return [];
  const accounts: SonosSpotifyAccount[] = [];
  for (const block of allTagBlocks(didl, "item")) {
    const uri = tagText(block, "res");
    if (!uri || !/spotify%3a/i.test(uri)) continue;
    const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
    const sid = Number.parseInt(params.get("sid") ?? "", 10);
    const sn = Number.parseInt(params.get("sn") ?? "", 10);
    if (!Number.isInteger(sid) || !Number.isInteger(sn)) continue;
    // Favorites keep the token in their embedded metadata; queue items carry it directly.
    const metadata = tagText(block, "r:resMD") ?? block;
    const desc = tagText(metadata, "desc");
    const token = desc && /^SA_RINCON\d+_/.test(desc) ? desc : defaultSpotifyToken(sid);
    const title = tagText(block, "dc:title");
    let account = accounts.find((entry) => entry.sid === sid && entry.sn === sn);
    if (!account) {
      account = { sid, sn, token, seenOn: [], uses: 0 };
      accounts.push(account);
    }
    account.uses += 1;
    if (title && account.seenOn.length < SEEN_ON_MAX && !account.seenOn.includes(title)) account.seenOn.push(title);
  }
  return accounts;
}

export function mergeSpotifyAccounts(lists: SonosSpotifyAccount[][]): SonosSpotifyAccount[] {
  const merged: SonosSpotifyAccount[] = [];
  for (const account of lists.flat()) {
    const existing = merged.find((entry) => entry.sid === account.sid && entry.sn === account.sn);
    if (!existing) {
      merged.push({ ...account, seenOn: [...account.seenOn] });
      continue;
    }
    existing.uses += account.uses;
    // A real per-account token beats the generic fallback.
    if (existing.token === defaultSpotifyToken(existing.sid)) existing.token = account.token;
    for (const title of account.seenOn) {
      if (existing.seenOn.length < SEEN_ON_MAX && !existing.seenOn.includes(title)) existing.seenOn.push(title);
    }
  }
  return merged.sort((a, b) => b.uses - a.uses || a.sn - b.sn);
}

// The queue entry for a Spotify URI. A track is one entry; an album or playlist goes
// in as a container, which Sonos expands into its tracks itself. URI forms and flags
// match what the Sonos app writes into favorites.
export function spotifyQueueItem(track: SourceTrackInfo, account: Pick<SonosSpotifyAccount, "sid" | "sn" | "token">): { uri: string; metadata: string } {
  const encoded = encodeURIComponent(track.url);
  const isTrack = track.url.startsWith("spotify:track:");
  const uri = isTrack
    ? `x-sonos-spotify:${encoded}?sid=${account.sid}&flags=8232&sn=${account.sn}`
    : `x-rincon-cpcontainer:1006206c${encoded}?sid=${account.sid}&flags=8300&sn=${account.sn}`;
  const itemId = isTrack ? `10032028${encoded}` : `1006206c${encoded}`;
  const upnpClass = isTrack ? "object.item.audioItem.musicTrack" : "object.container.playlistContainer";
  const inner =
    `<item id="${escapeXml(itemId)}" parentID="-1" restricted="true">` +
    `<dc:title>${escapeXml(track.title)}</dc:title>` +
    (track.artist ? `<dc:creator>${escapeXml(track.artist)}</dc:creator>` : "") +
    (track.album && isTrack ? `<upnp:album>${escapeXml(track.album)}</upnp:album>` : "") +
    (track.albumArtUri ? `<upnp:albumArtURI>${escapeXml(track.albumArtUri)}</upnp:albumArtURI>` : "") +
    `<upnp:class>${upnpClass}</upnp:class>` +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${escapeXml(account.token)}</desc>` +
    `</item>`;
  const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">${inner}</DIDL-Lite>`;
  return { uri, metadata };
}

// The Spotify track URI behind a queue/now-playing URI, whoever queued it (MiSonos,
// the Sonos app, a favorite).
export function spotifyTrackFromSonosUri(uri: string | undefined): string | undefined {
  const match = uri?.match(/^x-sonos-spotify:(spotify%3atrack%3a[A-Za-z0-9]+)\?/i);
  if (!match) return undefined;
  return decodeURIComponent(match[1]);
}

// --- Switching a Spotify login, and Spotify radio ------------------------------------

type SpotifyAccountRef = Pick<SonosSpotifyAccount, "sid" | "sn" | "token">;

const DIDL_ROOT_OPEN = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">`;

/** A URI Sonos plays through a Spotify login: a song, a whole album or playlist, or radio. */
export function isSonosSpotifyUri(uri: string | undefined): boolean {
  if (!uri) return false;
  return /^x-sonos-spotify:/i.test(uri) || /^(x-sonosapi-radio|x-rincon-cpcontainer):[0-9a-f]*spotify%3a/i.test(uri);
}

/** Which login (sid, sn) a Sonos Spotify URI plays on. */
export function spotifyAccountOfUri(uri: string | undefined): { sid: number; sn: number } | undefined {
  if (!uri || !isSonosSpotifyUri(uri)) return undefined;
  const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  const sid = Number.parseInt(params.get("sid") ?? "", 10);
  const sn = Number.parseInt(params.get("sn") ?? "", 10);
  return Number.isInteger(sid) && Number.isInteger(sn) ? { sid, sn } : undefined;
}

/** The same Sonos Spotify URI on another login. Anything else comes back unchanged. */
export function withSpotifyAccount(uri: string, account: Pick<SonosSpotifyAccount, "sid" | "sn">): string {
  if (!spotifyAccountOfUri(uri)) return uri;
  return uri.replace(/([?&]sid=)\d+/, `$1${account.sid}`).replace(/([?&]sn=)\d+/, `$1${account.sn}`);
}

/** DIDL metadata with the login's token (the cdudn desc) swapped in. */
export function withSpotifyToken(metadata: string, token: string): string {
  return metadata.replace(/(<desc\b[^>]*>)SA_RINCON[^<]*(<\/desc>)/gi, `$1${escapeXml(token)}$2`);
}

/** A queued item as ContentDirectory lists it (Q:0): its URI and its <item> markup. */
export interface QueuedItem {
  uri: string;
  xml: string;
  title: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
}

/**
 * The queue entry that plays `item` on `account`. A Spotify song gets fresh metadata in
 * the form MiSonos queues it; anything else is queued again as it was.
 */
export function queuedItemOnAccount(item: QueuedItem, account: SpotifyAccountRef): { uri: string; metadata: string; spotify: boolean } {
  const track = spotifyTrackFromSonosUri(item.uri);
  if (track) {
    const entry = spotifyQueueItem({ id: track, title: item.title, artist: item.artist, album: item.album, albumArtUri: item.albumArtUri, url: track }, account);
    return { ...entry, spotify: true };
  }
  if (isSonosSpotifyUri(item.uri)) {
    return { uri: withSpotifyAccount(item.uri, account), metadata: withSpotifyToken(didlOf(item.xml), account.token), spotify: true };
  }
  return { uri: item.uri, metadata: didlOf(item.xml), spotify: false };
}

// An <item> from the queue listing as metadata to queue again: its queue ids ("Q:0/7")
// mean nothing outside the queue.
function didlOf(itemXml: string): string {
  const item = itemXml.replace(/^<item\b[^>]*>/i, (open) => open
    .replace(/\sid="[^"]*"/i, ' id="-1"')
    .replace(/\sparentID="[^"]*"/i, ' parentID="-1"'));
  return `${DIDL_ROOT_OPEN}${item}</DIDL-Lite>`;
}

/**
 * Spotify's radio for an artist, the way the Sonos app starts it: endless songs like
 * the artist's, on `account`. Sonos documents no radio for a single song.
 */
export function spotifyArtistRadioItem(artist: { id: string; name: string }, account: SpotifyAccountRef): { uri: string; metadata: string } {
  // Lower-case %3a, as the Sonos app writes these ids.
  const id = encodeURIComponent(`spotify:artistRadio:${artist.id}`).replace(/%3A/g, "%3a");
  const parent = encodeURIComponent(`spotify:artist:${artist.id}`).replace(/%3A/g, "%3a");
  const uri = `x-sonosapi-radio:${id}?sid=${account.sid}&flags=8300&sn=${account.sn}`;
  const metadata = DIDL_ROOT_OPEN +
    `<item id="100c206c${escapeXml(id)}" parentID="10052064${escapeXml(parent)}" restricted="true">` +
    `<dc:title>${escapeXml(`${artist.name} Radio`)}</dc:title>` +
    `<upnp:class>object.item.audioItem.audioBroadcast.#artistRadio</upnp:class>` +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${escapeXml(account.token)}</desc>` +
    `</item></DIDL-Lite>`;
  return { uri, metadata };
}
