import { escapeXml } from "@misonos/sonos-protocol";
import { describe, expect, it } from "vitest";
import {
  defaultSpotifyToken,
  isSpotifyUri,
  mergeSpotifyAccounts,
  spotifyAccountsInDidl,
  spotifyQueueItem,
  spotifyTrackFromSonosUri
} from "../src/spotifySonos.js";

const DIDL_OPEN = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">`;

// A Sonos favorite as ContentDirectory returns it in FV:2: the playable URI in <res>,
// and the item's own metadata (with the account token) escaped inside r:resMD.
function favorite(index: number, title: string, uri: string, token: string): string {
  const resMD = `${DIDL_OPEN}<item id="10032028x" parentID="10032028x" restricted="true"><dc:title>${escapeXml(title)}</dc:title>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${token}</desc></item></DIDL-Lite>`;
  return `<item id="FV:2/${index}" parentID="FV:2" restricted="false"><dc:title>${escapeXml(title)}</dc:title>` +
    `<upnp:class>object.itemobject.item.sonos-favorite</upnp:class>` +
    `<res protocolInfo="sonos.com-spotify:*:audio/x-spotify:*">${escapeXml(uri)}</res>` +
    `<r:type>instantPlay</r:type><r:resMD>${escapeXml(resMD)}</r:resMD></item>`;
}

const FAVORITES = DIDL_OPEN +
  favorite(0, "Track A", "x-sonos-spotify:spotify%3Atrack%3AaaaAAA111?sid=9&flags=8232&sn=6", "SA_RINCON2311_X_#Svc2311-0000aaaa-Token") +
  favorite(1, "Track B", "x-sonos-spotify:spotify%3Atrack%3AbbbBBB222?sid=9&flags=8232&sn=3", "SA_RINCON2311_X_#Svc2311-0000bbbb-Token") +
  favorite(2, "Track C", "x-sonos-spotify:spotify%3Atrack%3AcccCCC333?sid=9&flags=8232&sn=3", "SA_RINCON2311_X_#Svc2311-0000bbbb-Token") +
  favorite(3, "An Album", "x-rincon-cpcontainer:1006206cspotify%3aalbum%3adddDDD444?sid=9&flags=8300&sn=5", "SA_RINCON2311_X_#Svc2311-0000cccc-Token") +
  // A favorite from another service is ignored.
  favorite(4, "Radio", "x-sonosapi-radio:stations%2Fabc?sid=303&flags=8300&sn=1", "SA_RINCON77575_X_#Svc77575-0-Token") +
  `</DIDL-Lite>`;

describe("spotifyAccountsInDidl", () => {
  it("reads each Spotify account and its token off Sonos Favorites", () => {
    const accounts = spotifyAccountsInDidl(FAVORITES);
    expect(accounts).toEqual([
      { sid: 9, sn: 6, token: "SA_RINCON2311_X_#Svc2311-0000aaaa-Token", seenOn: ["Track A"], uses: 1 },
      { sid: 9, sn: 3, token: "SA_RINCON2311_X_#Svc2311-0000bbbb-Token", seenOn: ["Track B", "Track C"], uses: 2 },
      { sid: 9, sn: 5, token: "SA_RINCON2311_X_#Svc2311-0000cccc-Token", seenOn: ["An Album"], uses: 1 }
    ]);
  });

  it("reads queue items, which carry the token directly", () => {
    const queue = DIDL_OPEN +
      `<item id="Q:0/1" parentID="Q:0" restricted="true"><res protocolInfo="sonos.com-spotify:*:audio/x-spotify:*">x-sonos-spotify:spotify%3atrack%3aeeeEEE555?sid=9&amp;flags=8224&amp;sn=3</res>` +
      `<dc:title>Queued</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
      `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON2311_X_#Svc2311-0000bbbb-Token</desc></item></DIDL-Lite>`;
    expect(spotifyAccountsInDidl(queue)).toEqual([
      { sid: 9, sn: 3, token: "SA_RINCON2311_X_#Svc2311-0000bbbb-Token", seenOn: ["Queued"], uses: 1 }
    ]);
  });

  it("falls back to the service's generic token when an item has none", () => {
    const queue = `${DIDL_OPEN}<item id="Q:0/1"><res>x-sonos-spotify:spotify%3atrack%3afff?sid=12&amp;sn=1</res><dc:title>T</dc:title></item></DIDL-Lite>`;
    expect(spotifyAccountsInDidl(queue)[0].token).toBe(defaultSpotifyToken(12));
    expect(defaultSpotifyToken(9)).toBe("SA_RINCON2311_X_#Svc2311-0-Token");
  });
});

describe("mergeSpotifyAccounts", () => {
  it("merges listings, most used first, preferring a real token over the generic one", () => {
    const merged = mergeSpotifyAccounts([
      [{ sid: 9, sn: 6, token: defaultSpotifyToken(9), seenOn: ["Q1"], uses: 1 }],
      spotifyAccountsInDidl(FAVORITES)
    ]);
    expect(merged.map((account) => [account.sn, account.uses])).toEqual([[3, 2], [6, 2], [5, 1]]);
    expect(merged.find((account) => account.sn === 6)).toMatchObject({
      token: "SA_RINCON2311_X_#Svc2311-0000aaaa-Token",
      seenOn: ["Q1", "Track A"]
    });
  });
});

describe("spotifyQueueItem", () => {
  const account = { sid: 9, sn: 3, token: "SA_RINCON2311_X_#Svc2311-0000bbbb-Token" };

  it("queues a track as x-sonos-spotify with the account's token", () => {
    const item = spotifyQueueItem({ id: "spotify:track:abc", title: "Song & Dance", artist: "Band", album: "LP", url: "spotify:track:abc" }, account);
    expect(item.uri).toBe("x-sonos-spotify:spotify%3Atrack%3Aabc?sid=9&flags=8232&sn=3");
    expect(item.metadata).toContain(`<item id="10032028spotify%3Atrack%3Aabc"`);
    expect(item.metadata).toContain("<dc:title>Song &amp; Dance</dc:title>");
    expect(item.metadata).toContain("<upnp:class>object.item.audioItem.musicTrack</upnp:class>");
    expect(item.metadata).toContain(">SA_RINCON2311_X_#Svc2311-0000bbbb-Token</desc>");
  });

  it("queues an album or playlist as a container Sonos expands", () => {
    const item = spotifyQueueItem({ id: "spotify:playlist:xyz", title: "Mix", url: "spotify:playlist:xyz" }, account);
    expect(item.uri).toBe("x-rincon-cpcontainer:1006206cspotify%3Aplaylist%3Axyz?sid=9&flags=8300&sn=3");
    expect(item.metadata).toContain("<upnp:class>object.container.playlistContainer</upnp:class>");
  });
});

describe("Spotify URIs", () => {
  it("recognizes playable Spotify URIs only", () => {
    expect(isSpotifyUri("spotify:track:abc123")).toBe(true);
    expect(isSpotifyUri("spotify:playlist:abc123")).toBe(true);
    expect(isSpotifyUri("spotify:artist:abc123")).toBe(false);
    expect(isSpotifyUri("http://host/stream")).toBe(false);
    expect(isSpotifyUri(undefined)).toBe(false);
  });

  it("maps a Sonos Spotify track URI back to the Spotify URI, either hex case", () => {
    expect(spotifyTrackFromSonosUri("x-sonos-spotify:spotify%3Atrack%3A15ErUnXk?sid=9&flags=8232&sn=6")).toBe("spotify:track:15ErUnXk");
    expect(spotifyTrackFromSonosUri("x-sonos-spotify:spotify%3atrack%3a15ErUnXk?sid=9&flags=8224&sn=3")).toBe("spotify:track:15ErUnXk");
    expect(spotifyTrackFromSonosUri("x-sonos-http:abc.mp4?sid=240&sn=0")).toBeUndefined();
  });
});
