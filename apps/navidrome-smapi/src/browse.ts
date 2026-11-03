import type { SourceBrowseItem, SourceBrowseResponse, SourceTrackInfo } from "@misonos/sonos-protocol";
import { streamMime } from "./formats.js";
import { decodeId, encodeId, type NavidromeId } from "./ids.js";
import {
  SubsonicClient,
  SubsonicError,
  type AlbumListType,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicPlaylist,
  type SubsonicResults,
  type SubsonicSong
} from "./subsonic.js";

// Short, because unlike the archive sources this is a library the user edits.
const CACHE_TTL_MS = 5 * 60 * 1000;
const ART_SIZE = 300;

const ALBUM_LISTS: { list: AlbumListType; title: string }[] = [
  { list: "newest", title: "Recently Added" },
  { list: "recent", title: "Recently Played" },
  { list: "frequent", title: "Most Played" },
  { list: "random", title: "Random" },
  { list: "alphabeticalByName", title: "A–Z" }
];

interface CacheEntry<T> { value: T; expires: number }

export class NavidromeBrowser {
  private cache = new Map<string, CacheEntry<unknown>>();
  // One playlist change at a time, so two at once can't both create the playlist.
  private playlistChanges: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: SubsonicClient, private readonly options: { transcodeFormat: string }) {}

  // `base` is this service's own URL: art and streams are served through it so
  // the Navidrome credentials never leave the process.
  async browse(rawId: string, base: string): Promise<SourceBrowseResponse> {
    const id = decodeId(rawId);
    const items = await this.browseId(id, base);
    return { id: rawId, total: items.length, items };
  }

  async search(query: string, base: string): Promise<SourceBrowseResponse> {
    const items = resultSections(await this.api.search(query), base);
    return { id: `search:${query}`, title: `“${query}”`, total: items.length, items };
  }

  /**
   * Adds tracks to this user's playlist `name`, leaving out any already in it. With no
   * such playlist it makes one, public like the imported ones, so every Navidrome user
   * sees it.
   */
  appendToPlaylist(name: string, rawIds: string[]): Promise<{ id: string; added: number }> {
    const change = this.playlistChanges.then(() => this.append(name, rawIds));
    this.playlistChanges = change.catch(() => undefined);
    return change;
  }

  private async append(name: string, rawIds: string[]): Promise<{ id: string; added: number }> {
    const songIds = [...new Set(rawIds.map((rawId) => {
      const id = decodeId(rawId);
      if (id.kind !== "track") throw new Error("Not a track id");
      return id.songId;
    }))];
    const own = async () => (await this.api.playlists()).find((playlist) => playlist.name === name && playlist.owner === this.api.username);
    this.cache.delete("playlists");
    const existing = await own();
    if (!existing) {
      const created = (await this.api.createPlaylist(name, songIds)) ?? (await own());
      if (!created) throw new Error(`Navidrome didn't make the ${name} playlist`);
      await this.api.updatePlaylist(created.id, { public: true });
      return { id: created.id, added: songIds.length };
    }
    const have = new Set((await this.api.playlist(existing.id)).entry?.map((song) => song.id));
    const fresh = songIds.filter((id) => !have.has(id));
    if (fresh.length) await this.api.updatePlaylist(existing.id, { songIdToAdd: fresh });
    return { id: existing.id, added: fresh.length };
  }

  async track(rawId: string, base: string): Promise<SourceTrackInfo> {
    const id = decodeId(rawId);
    if (id.kind !== "track") throw new Error("Not a track id");
    const song = await this.api.song(id.songId);
    return {
      id: rawId,
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationSeconds: song.duration,
      albumArtUri: artUrl(base, song.coverArt),
      url: `${base}/stream?id=${encodeURIComponent(song.id)}`,
      mimeType: streamMime(song, this.options.transcodeFormat)
    };
  }

  private async browseId(id: NavidromeId, base: string): Promise<SourceBrowseItem[]> {
    switch (id.kind) {
      case "root":
        return [
          container(encodeId({ kind: "artists" }), "Artists"),
          container(encodeId({ kind: "albums" }), "Albums"),
          container(encodeId({ kind: "playlists" }), "Playlists"),
          container(encodeId({ kind: "genres" }), "Genres"),
          container(encodeId({ kind: "starred" }), "Starred")
        ];
      case "albums":
        return ALBUM_LISTS.map(({ list, title }) => container(encodeId({ kind: "albumList", list }), title));
      case "albumList": {
        // Random must differ per visit; A–Z pages the whole library, so cache it.
        const albums = id.list === "alphabeticalByName"
          ? await this.cached("albums:az", () => this.api.albumList(id.list))
          : await this.api.albumList(id.list);
        return albums.map((album) => albumItem(album, base));
      }
      case "artists": {
        const artists = await this.cached("artists", () => this.api.artists());
        return artists.map((artist) => artistItem(artist, base));
      }
      case "artist": {
        const artist = await this.api.artist(id.artistId);
        const albums = [...(artist.album ?? [])].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.name.localeCompare(b.name));
        return albums.map((album) => albumItem(album, base));
      }
      case "album": {
        const album = await this.api.album(id.albumId);
        return (album.song ?? []).map((song) => trackItem(song, base));
      }
      case "playlists": {
        const playlists = await this.cached("playlists", () => this.api.playlists());
        return playlists.map((playlist) => playlistItem(playlist, base));
      }
      case "playlist": {
        const playlist = await this.api.playlist(id.playlistId);
        return (playlist.entry ?? []).map((song) => trackItem(song, base));
      }
      case "genres": {
        const genres = await this.cached("genres", () => this.api.genres());
        return [...genres]
          .sort((a, b) => a.value.localeCompare(b.value))
          .map((genre) => container(
            encodeId({ kind: "genre", genre: genre.value }),
            genre.value,
            genre.albumCount ? `${genre.albumCount} albums` : undefined
          ));
      }
      case "genre": {
        const albums = await this.api.albumsByGenre(id.genre);
        return albums.map((album) => albumItem(album, base));
      }
      case "starred":
        return resultSections(await this.api.starred(), base);
      case "track":
        throw new Error("Tracks are leaves, not browsable");
    }
  }

  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expires > now) return entry.value;
    try {
      const value = await fetcher();
      this.cache.set(key, { value, expires: now + CACHE_TTL_MS });
      return value;
    } catch (error) {
      if (error instanceof SubsonicError && entry) return entry.value;
      throw error;
    }
  }
}

// Search results and starred items share one shape: artists, albums and songs,
// each under a section header, empty groups left out.
function resultSections(results: SubsonicResults, base: string): SourceBrowseItem[] {
  const items: SourceBrowseItem[] = [];
  const artists = results.artist ?? [];
  const albums = results.album ?? [];
  const songs = results.song ?? [];
  if (artists.length) items.push(section("artists", "Artists"), ...artists.map((artist) => artistItem(artist, base)));
  if (albums.length) items.push(section("albums", "Albums"), ...albums.map((album) => albumItem(album, base)));
  if (songs.length) items.push(section("songs", "Songs"), ...songs.map((song) => trackItem(song, base)));
  return items;
}

export function artUrl(base: string, coverArt: string | undefined): string | undefined {
  if (!coverArt) return undefined;
  return `${base}/art?id=${encodeURIComponent(coverArt)}&size=${ART_SIZE}`;
}

function container(id: string, title: string, subtitle?: string): SourceBrowseItem {
  return { id, title, kind: "container", subtitle };
}

function section(key: string, title: string): SourceBrowseItem {
  return { id: `section:${key}`, title, kind: "section" };
}

function artistItem(artist: SubsonicArtist, base: string): SourceBrowseItem {
  return {
    id: encodeId({ kind: "artist", artistId: artist.id }),
    title: artist.name,
    kind: "container",
    subtitle: artist.albumCount ? `${artist.albumCount} ${artist.albumCount === 1 ? "album" : "albums"}` : undefined,
    albumArtUri: artUrl(base, artist.coverArt)
  };
}

function albumItem(album: SubsonicAlbum, base: string): SourceBrowseItem {
  return {
    id: encodeId({ kind: "album", albumId: album.id }),
    title: album.name,
    kind: "album",
    subtitle: [album.artist, album.year ? String(album.year) : undefined].filter(Boolean).join(" · ") || undefined,
    artist: album.artist,
    albumArtUri: artUrl(base, album.coverArt)
  };
}

function playlistItem(playlist: SubsonicPlaylist, base: string): SourceBrowseItem {
  const count = playlist.songCount ? `${playlist.songCount} ${playlist.songCount === 1 ? "song" : "songs"}` : undefined;
  return {
    id: encodeId({ kind: "playlist", playlistId: playlist.id }),
    title: playlist.name,
    kind: "album",
    subtitle: [count, playlist.comment].filter(Boolean).join(" · ") || undefined,
    albumArtUri: artUrl(base, playlist.coverArt)
  };
}

function trackItem(song: SubsonicSong, base: string): SourceBrowseItem {
  return {
    id: encodeId({ kind: "track", songId: song.id }),
    title: song.title,
    kind: "playable",
    artist: song.artist,
    album: song.album,
    durationSeconds: song.duration,
    albumArtUri: artUrl(base, song.coverArt)
  };
}
