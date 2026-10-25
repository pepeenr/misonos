import type { SourceBrowseItem, SourceBrowseResponse, SourceTrackInfo } from "@misonos/sonos-protocol";
import { decodeNode, encodeNode, IdError, parseSpotifyUri, spotifyUri, type LibraryList, type SpotifyNode } from "./ids.js";
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyClient,
  SpotifyImage,
  SpotifyPaging,
  SpotifyPlaylist,
  SpotifyPlaylistEntry,
  SpotifySearchResults,
  SpotifyTrack
} from "./spotify.js";

const PAGE = 50;
// Lists are capped (the bridge has no paging). Playing an album or playlist row
// queues it whole through Sonos, so the cap only limits what a list shows.
const MAX_TRACKS = 300;
const MAX_LIST = 500;
// An artist's releases page at most 10 at a time (since February 2026), so fewer.
const ARTIST_PAGE = 10;
const MAX_ARTIST_ALBUMS = 100;
// The API's maximum per type since February 2026.
const SEARCH_LIMIT = 10;
const ART_WIDTH = 300;
const TRACK_CACHE_MAX = 5000;

const ROOT: { list: LibraryList; title: string }[] = [
  { list: "playlists", title: "Playlists" },
  { list: "tracks", title: "Liked Songs" },
  { list: "albums", title: "Albums" },
  { list: "artists", title: "Artists" },
  { list: "recent", title: "Recently Played" },
  { list: "top", title: "Top Tracks" }
];

const ALBUM_GROUPS: { type: string; title: string }[] = [
  { type: "album", title: "Albums" },
  { type: "single", title: "Singles & EPs" },
  { type: "compilation", title: "Compilations" }
];

export class SpotifyBrowser {
  // Tracks seen in listings, so playing one doesn't refetch it: the API no longer
  // has a batch lookup.
  private tracks = new Map<string, SourceTrackInfo>();

  constructor(private readonly api: SpotifyClient) {}

  async browse(rawId: string): Promise<SourceBrowseResponse> {
    const items = await this.browseNode(decodeNode(rawId));
    return { id: rawId, total: items.length, items };
  }

  async search(query: string): Promise<SourceBrowseResponse> {
    const results = await this.api.get<SpotifySearchResults>("/search", {
      q: query,
      type: "track,artist,album,playlist",
      limit: SEARCH_LIMIT
    });
    const tracks = this.trackItems(results.tracks?.items ?? []);
    const artists = present(results.artists?.items).map(artistItem);
    const albums = present(results.albums?.items).map(albumItem);
    const playlists = present(results.playlists?.items).map(playlistItem);
    const items: SourceBrowseItem[] = [];
    if (tracks.length) items.push(section("songs", "Songs"), ...tracks);
    if (artists.length) items.push(section("artists", "Artists"), ...artists);
    if (albums.length) items.push(section("albums", "Albums"), ...albums);
    if (playlists.length) items.push(section("playlists", "Playlists"), ...playlists);
    return { id: `search:${query}`, title: `“${query}”`, total: items.length, items };
  }

  // Metadata for a playable id. Its `url` is the Spotify URI itself: the bridge plays
  // it through the Spotify account linked to Sonos.
  async track(rawId: string): Promise<SourceTrackInfo> {
    const uri = parseSpotifyUri(rawId);
    if (!uri) throw new IdError(`Not a Spotify URI: ${rawId}`);
    switch (uri.type) {
      case "track": {
        const cached = this.tracks.get(rawId);
        if (cached) return cached;
        const track = await this.api.get<SpotifyTrack>(`/tracks/${uri.id}`);
        return this.remember(track) ?? { id: rawId, title: track.name, url: rawId };
      }
      case "album": {
        const album = await this.api.get<SpotifyAlbum>(`/albums/${uri.id}`);
        return { id: rawId, title: album.name, artist: artistNames(album.artists), album: album.name, albumArtUri: art(album.images), url: rawId };
      }
      case "playlist": {
        const playlist = await this.api.get<SpotifyPlaylist>(`/playlists/${uri.id}`, { fields: "id,name,images,owner(id,display_name)" });
        return { id: rawId, title: playlist.name, artist: playlist.owner?.display_name ?? undefined, albumArtUri: art(playlist.images), url: rawId };
      }
    }
  }

  private async browseNode(node: SpotifyNode): Promise<SourceBrowseItem[]> {
    switch (node.kind) {
      case "root":
        return ROOT.map(({ list, title }) => container(encodeNode({ kind: "library", list }), title));
      case "library":
        return this.library(node.list);
      case "playlist":
        return this.playlist(node.id);
      case "album": {
        const album = await this.api.get<SpotifyAlbum>(`/albums/${node.id}`);
        const tracks = album.tracks ? await this.api.collect(album.tracks, MAX_TRACKS) : [];
        return this.trackItems(tracks, album);
      }
      case "artist": {
        const albums = await this.api.pages<SpotifyAlbum>(
          `/artists/${node.id}/albums`,
          { include_groups: ALBUM_GROUPS.map((group) => group.type).join(","), limit: ARTIST_PAGE },
          MAX_ARTIST_ALBUMS
        );
        return ALBUM_GROUPS.flatMap(({ type, title }) => {
          const group = albums.filter((album) => (album.album_type ?? "album") === type);
          return group.length ? [section(type, title), ...group.map(albumItem)] : [];
        });
      }
    }
  }

  private async library(list: LibraryList): Promise<SourceBrowseItem[]> {
    switch (list) {
      case "playlists": {
        const playlists = await this.api.pages<SpotifyPlaylist | null>("/me/playlists", { limit: PAGE }, MAX_LIST);
        return present(playlists).map(playlistItem);
      }
      case "tracks": {
        const saved = await this.api.pages<SpotifyPlaylistEntry>("/me/tracks", { limit: PAGE }, MAX_TRACKS);
        return this.trackItems(saved.map(entryTrack));
      }
      case "albums": {
        const saved = await this.api.pages<{ album?: SpotifyAlbum | null }>("/me/albums", { limit: PAGE }, MAX_LIST);
        return present(saved.map((entry) => entry.album)).map(albumItem);
      }
      case "artists": {
        const artists = await this.api.pages<SpotifyArtist>(
          "/me/following",
          { type: "artist", limit: PAGE },
          MAX_LIST,
          (body) => (body as { artists: SpotifyPaging<SpotifyArtist> }).artists
        );
        return artists.map(artistItem);
      }
      case "recent": {
        const played = await this.api.get<SpotifyPaging<SpotifyPlaylistEntry>>("/me/player/recently-played", { limit: PAGE });
        return this.trackItems(played.items.map(entryTrack));
      }
      case "top": {
        const top = await this.api.get<SpotifyPaging<SpotifyTrack>>("/me/top/tracks", { limit: PAGE, time_range: "medium_term" });
        return this.trackItems(top.items);
      }
    }
  }

  private async playlist(id: string): Promise<SourceBrowseItem[]> {
    const playlist = await this.api.get<SpotifyPlaylist>(`/playlists/${id}`, { additional_types: "track" });
    const page = playlist.items ?? playlist.tracks;
    // Spotify lists the items only of playlists the user owns or collaborates on.
    // Any other playlist still plays whole, through Sonos's own Spotify link.
    if (!Array.isArray(page?.items)) {
      return [section("whole", "Spotify shares this playlist's tracks only with its owner"), wholePlaylistItem(playlist)];
    }
    const entries = await this.api.collect({ items: page.items, next: page.next ?? null }, MAX_TRACKS);
    return this.trackItems(entries.map(entryTrack));
  }

  // Playable tracks only (no local files or podcast episodes), each once.
  private trackItems(tracks: (SpotifyTrack | null | undefined)[], album?: SpotifyAlbum): SourceBrowseItem[] {
    const seen = new Set<string>();
    const items: SourceBrowseItem[] = [];
    for (const track of tracks) {
      const info = this.remember(track, album);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      items.push({
        id: info.id,
        title: info.title,
        kind: "playable",
        artist: info.artist,
        album: info.album,
        durationSeconds: info.durationSeconds,
        albumArtUri: info.albumArtUri
      });
    }
    return items;
  }

  private remember(track: SpotifyTrack | null | undefined, album?: SpotifyAlbum): SourceTrackInfo | undefined {
    if (!track?.id || track.is_local || (track.type ?? "track") !== "track") return undefined;
    const from = album ?? track.album;
    const id = spotifyUri("track", track.id);
    const info: SourceTrackInfo = {
      id,
      title: track.name,
      artist: artistNames(track.artists),
      album: from?.name,
      durationSeconds: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
      albumArtUri: art(from?.images),
      url: id
    };
    if (this.tracks.size >= TRACK_CACHE_MAX) this.tracks.clear();
    this.tracks.set(id, info);
    return info;
  }
}

function entryTrack(entry: SpotifyPlaylistEntry | null | undefined): SpotifyTrack | null | undefined {
  return entry?.item ?? entry?.track;
}

function present<T>(values: (T | null | undefined)[] | undefined): T[] {
  return (values ?? []).filter((value): value is T => value !== null && value !== undefined);
}

// The smallest image at least ART_WIDTH wide, else the largest.
export function art(images: SpotifyImage[] | null | undefined): string | undefined {
  if (!images?.length) return undefined;
  const sized = images.filter((image) => typeof image.width === "number");
  if (!sized.length) return images[0].url;
  const big = sized.filter((image) => (image.width ?? 0) >= ART_WIDTH).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (big[0] ?? sized.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]).url;
}

function artistNames(artists: SpotifyArtist[] | undefined): string | undefined {
  const names = (artists ?? []).map((artist) => artist.name).filter(Boolean);
  return names.length ? names.join(", ") : undefined;
}

function container(id: string, title: string): SourceBrowseItem {
  return { id, title, kind: "container" };
}

function section(key: string, title: string): SourceBrowseItem {
  return { id: `section:${key}`, title, kind: "section" };
}

function artistItem(artist: SpotifyArtist): SourceBrowseItem {
  return {
    id: encodeNode({ kind: "artist", id: artist.id }),
    title: artist.name,
    kind: "container",
    albumArtUri: art(artist.images)
  };
}

function albumItem(album: SpotifyAlbum): SourceBrowseItem {
  const artist = artistNames(album.artists);
  const year = album.release_date?.slice(0, 4);
  return {
    id: encodeNode({ kind: "album", id: album.id }),
    title: album.name,
    kind: "album",
    subtitle: [artist, year].filter(Boolean).join(" · ") || undefined,
    artist,
    albumArtUri: art(album.images),
    playId: spotifyUri("album", album.id)
  };
}

function playlistItem(playlist: SpotifyPlaylist): SourceBrowseItem {
  const total = playlist.items?.total ?? playlist.tracks?.total;
  const count = typeof total === "number" ? `${total} ${total === 1 ? "song" : "songs"}` : undefined;
  return {
    id: encodeNode({ kind: "playlist", id: playlist.id }),
    title: playlist.name,
    kind: "album",
    subtitle: [playlist.owner?.display_name, count].filter(Boolean).join(" · ") || undefined,
    albumArtUri: art(playlist.images),
    playId: spotifyUri("playlist", playlist.id)
  };
}

function wholePlaylistItem(playlist: SpotifyPlaylist): SourceBrowseItem {
  return {
    id: spotifyUri("playlist", playlist.id),
    title: playlist.name,
    kind: "playable",
    artist: playlist.owner?.display_name ?? undefined,
    album: "Whole playlist",
    albumArtUri: art(playlist.images)
  };
}
