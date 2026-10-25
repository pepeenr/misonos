import { describe, expect, it } from "vitest";
import { art, SpotifyBrowser } from "../src/browse.js";
import { SpotifyClient } from "../src/spotify.js";

const API = "https://api.spotify.com/v1";
const IMAGES = [
  { url: "https://i.scdn.co/640", width: 640, height: 640 },
  { url: "https://i.scdn.co/300", width: 300, height: 300 },
  { url: "https://i.scdn.co/64", width: 64, height: 64 }
];

function track(id: string, name: string, extra: object = {}) {
  return {
    id,
    name,
    type: "track",
    duration_ms: 201500,
    artists: [{ id: "ar1", name: "Artist One" }, { id: "ar2", name: "Artist Two" }],
    album: { id: "al1", name: "Album One", images: IMAGES },
    ...extra
  };
}

// A fake Web API: "METHOD path" (with query) → body. Unknown routes are 404s.
function fakeApi(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const key = `${url.pathname.replace("/v1", "")}${url.search}`;
    seen.push(key);
    const body = routes[key] ?? routes[url.pathname.replace("/v1", "")];
    if (body === undefined) return new Response(JSON.stringify({ error: { status: 404, message: "Not found" } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function browser(routes: Record<string, unknown>, seen?: string[]): SpotifyBrowser {
  const auth = { accessToken: async () => "token", refresh: async () => "token" };
  return new SpotifyBrowser(new SpotifyClient(auth, fakeApi(routes, seen)));
}

describe("SpotifyBrowser", () => {
  it("lists the library folders at the root without calling the API", async () => {
    const seen: string[] = [];
    const result = await browser({}, seen).browse("root");
    expect(result.items.map((item) => [item.id, item.title])).toEqual([
      ["me:playlists", "Playlists"],
      ["me:tracks", "Liked Songs"],
      ["me:albums", "Albums"],
      ["me:artists", "Artists"],
      ["me:recent", "Recently Played"],
      ["me:top", "Top Tracks"]
    ]);
    expect(seen).toEqual([]);
  });

  it("lists playlists as albums that play whole, following pages", async () => {
    const result = await browser({
      "/me/playlists?limit=50": {
        items: [{ id: "pl1", name: "Mine", owner: { id: "me", display_name: "Me" }, items: { total: 12 }, images: IMAGES }, null],
        next: `${API}/me/playlists?offset=50&limit=50`
      },
      "/me/playlists?offset=50&limit=50": {
        items: [{ id: "pl2", name: "Theirs", owner: { id: "them", display_name: "Them" }, tracks: { total: 1 }, images: [] }],
        next: null
      }
    }).browse("me:playlists");
    expect(result.items).toEqual([
      { id: "playlist:pl1", title: "Mine", kind: "album", subtitle: "Me · 12 songs", albumArtUri: "https://i.scdn.co/300", playId: "spotify:playlist:pl1" },
      { id: "playlist:pl2", title: "Theirs", kind: "album", subtitle: "Them · 1 song", albumArtUri: undefined, playId: "spotify:playlist:pl2" }
    ]);
  });

  it("lists an owned playlist's tracks, reading both entry shapes and skipping local files and episodes", async () => {
    const result = await browser({
      "/playlists/pl1": {
        id: "pl1",
        name: "Mine",
        items: {
          items: [
            { item: track("t1", "First") },
            { track: track("t2", "Second") },
            { item: track("t3", "Local", { is_local: true, id: null }) },
            { item: track("e1", "Episode", { type: "episode" }) }
          ],
          next: `${API}/playlists/pl1/items?offset=4&limit=50`
        }
      },
      "/playlists/pl1/items?offset=4&limit=50": { items: [{ item: track("t1", "First again") }, { item: track("t4", "Fourth") }], next: null }
    }).browse("playlist:pl1");
    expect(result.items.map((item) => item.id)).toEqual(["spotify:track:t1", "spotify:track:t2", "spotify:track:t4"]);
    expect(result.items[0]).toEqual({
      id: "spotify:track:t1",
      title: "First",
      kind: "playable",
      artist: "Artist One, Artist Two",
      album: "Album One",
      durationSeconds: 202,
      albumArtUri: "https://i.scdn.co/300"
    });
  });

  it("offers a playlist it can't list (not the user's) as one whole-playlist item", async () => {
    const result = await browser({
      "/playlists/pl2": { id: "pl2", name: "Theirs", owner: { id: "them", display_name: "Them" }, items: { total: 80 }, images: IMAGES }
    }).browse("playlist:pl2");
    expect(result.items).toEqual([
      { id: "section:whole", title: "Spotify shares this playlist's tracks only with its owner", kind: "section" },
      { id: "spotify:playlist:pl2", title: "Theirs", kind: "playable", artist: "Them", album: "Whole playlist", albumArtUri: "https://i.scdn.co/300" }
    ]);
  });

  it("fills album tracks with the album's name and art", async () => {
    const result = await browser({
      "/albums/al9": {
        id: "al9",
        name: "Ninth",
        images: IMAGES,
        tracks: { items: [{ id: "t9", name: "Nine", type: "track", duration_ms: 1000, artists: [{ id: "a", name: "A" }] }], next: null }
      }
    }).browse("album:al9");
    expect(result.items).toEqual([
      { id: "spotify:track:t9", title: "Nine", kind: "playable", artist: "A", album: "Ninth", durationSeconds: 1, albumArtUri: "https://i.scdn.co/300" }
    ]);
  });

  it("groups an artist's releases by type", async () => {
    const result = await browser({
      "/artists/ar1/albums?include_groups=album%2Csingle%2Ccompilation&limit=50": {
        items: [
          { id: "s1", name: "Single", album_type: "single", artists: [{ id: "ar1", name: "Artist One" }], release_date: "2024-03-01" },
          { id: "a1", name: "Debut", album_type: "album", artists: [{ id: "ar1", name: "Artist One" }], release_date: "2020" }
        ],
        next: null
      }
    }).browse("artist:ar1");
    expect(result.items.map((item) => [item.kind, item.title, item.subtitle])).toEqual([
      ["section", "Albums", undefined],
      ["album", "Debut", "Artist One · 2020"],
      ["section", "Singles & EPs", undefined],
      ["album", "Single", "Artist One · 2024"]
    ]);
    expect(result.items[1].playId).toBe("spotify:album:a1");
  });

  it("follows artists through the cursor-paged /me/following body", async () => {
    const result = await browser({
      "/me/following?type=artist&limit=50": { artists: { items: [{ id: "ar1", name: "Artist One", images: IMAGES }], next: null } }
    }).browse("me:artists");
    expect(result.items).toEqual([{ id: "artist:ar1", title: "Artist One", kind: "container", albumArtUri: "https://i.scdn.co/300" }]);
  });

  it("searches all four types at the API's limit of 10, under section headers", async () => {
    const seen: string[] = [];
    const result = await browser({
      "/search": {
        tracks: { items: [track("t1", "Song")], next: null },
        artists: { items: [{ id: "ar1", name: "Artist One" }], next: null },
        albums: { items: [], next: null },
        playlists: { items: [null, { id: "pl1", name: "List", owner: { id: "x", display_name: "X" } }], next: null }
      }
    }, seen).search("song");
    expect(seen[0]).toBe("/search?q=song&type=track%2Cartist%2Calbum%2Cplaylist&limit=10");
    expect(result.items.map((item) => [item.kind, item.title])).toEqual([
      ["section", "Songs"],
      ["playable", "Song"],
      ["section", "Artists"],
      ["container", "Artist One"],
      ["section", "Playlists"],
      ["album", "List"]
    ]);
  });

  it("answers /track from tracks seen in a listing, without another request", async () => {
    const seen: string[] = [];
    const spotify = browser({ "/me/top/tracks?limit=50&time_range=medium_term": { items: [track("t1", "Top")], next: null } }, seen);
    await spotify.browse("me:top");
    const info = await spotify.track("spotify:track:t1");
    expect(info).toMatchObject({ id: "spotify:track:t1", title: "Top", url: "spotify:track:t1" });
    expect(seen).toHaveLength(1);
  });

  it("looks up tracks, albums and playlists it hasn't seen", async () => {
    const spotify = browser({
      "/tracks/t5": track("t5", "Five"),
      "/albums/al5": { id: "al5", name: "Album Five", artists: [{ id: "a", name: "A" }], images: IMAGES },
      "/playlists/pl5": { id: "pl5", name: "List Five", owner: { id: "o", display_name: "Owner" }, images: IMAGES }
    });
    expect(await spotify.track("spotify:track:t5")).toMatchObject({ title: "Five", url: "spotify:track:t5", durationSeconds: 202 });
    expect(await spotify.track("spotify:album:al5")).toMatchObject({ title: "Album Five", artist: "A", url: "spotify:album:al5" });
    expect(await spotify.track("spotify:playlist:pl5")).toMatchObject({ title: "List Five", artist: "Owner", url: "spotify:playlist:pl5" });
  });

  it("rejects ids that aren't its own", async () => {
    const spotify = browser({});
    await expect(spotify.browse("album:../me")).rejects.toThrow(/Bad Spotify id/);
    await expect(spotify.browse("me:everything")).rejects.toThrow(/Unknown library list/);
    await expect(spotify.track("spotify:artist:abc")).rejects.toThrow(/Not a Spotify URI/);
  });
});

describe("art", () => {
  it("picks the smallest image at least 300 wide, else the largest", () => {
    expect(art(IMAGES)).toBe("https://i.scdn.co/300");
    expect(art([{ url: "small", width: 64 }, { url: "mid", width: 160 }])).toBe("mid");
    expect(art([{ url: "mosaic", width: null }])).toBe("mosaic");
    expect(art(undefined)).toBeUndefined();
  });
});
