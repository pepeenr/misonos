// Browse ids are this source's own ("root", "me:playlists", "album:<id>", …). Playable
// ids are plain Spotify URIs ("spotify:track:<id>"): the bridge hands those to Sonos's
// linked Spotify account as they are, so a favorite or a recently played entry keeps
// working even when the Web API is unavailable.

export type LibraryList = "playlists" | "tracks" | "albums" | "artists" | "recent" | "top";

export type SpotifyNode =
  | { kind: "root" }
  | { kind: "library"; list: LibraryList }
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string };

export type SpotifyUriType = "track" | "album" | "playlist";

export interface SpotifyUri {
  type: SpotifyUriType;
  id: string;
}

export class IdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdError";
  }
}

const LIBRARY_LISTS: readonly LibraryList[] = ["playlists", "tracks", "albums", "artists", "recent", "top"];
// Spotify ids are base62. Checking that also keeps an id from reaching into an API path.
const SPOTIFY_ID = /^[A-Za-z0-9]+$/;

export function encodeNode(node: SpotifyNode): string {
  switch (node.kind) {
    case "root": return "root";
    case "library": return `me:${node.list}`;
    case "playlist": return `playlist:${node.id}`;
    case "album": return `album:${node.id}`;
    case "artist": return `artist:${node.id}`;
  }
}

export function decodeNode(raw: string): SpotifyNode {
  if (raw === "root") return { kind: "root" };
  const colon = raw.indexOf(":");
  if (colon < 0) throw new IdError(`Unknown id: ${raw}`);
  const prefix = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (prefix === "me") {
    const list = LIBRARY_LISTS.find((entry) => entry === rest);
    if (!list) throw new IdError(`Unknown library list: ${rest}`);
    return { kind: "library", list };
  }
  if (!SPOTIFY_ID.test(rest)) throw new IdError(`Bad Spotify id: ${raw}`);
  switch (prefix) {
    case "playlist": return { kind: "playlist", id: rest };
    case "album": return { kind: "album", id: rest };
    case "artist": return { kind: "artist", id: rest };
    default: throw new IdError(`Unknown id prefix: ${prefix}`);
  }
}

export function spotifyUri(type: SpotifyUriType, id: string): string {
  return `spotify:${type}:${id}`;
}

export function parseSpotifyUri(raw: string): SpotifyUri | undefined {
  const match = raw.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/);
  if (!match) return undefined;
  return { type: match[1] as SpotifyUriType, id: match[2] };
}
