import type { SpotifyAuth } from "./auth.js";

const API_BASE = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MS = 10000;
// Wait out a short rate limit once; a longer one surfaces as an error.
const MAX_RETRY_AFTER_S = 5;

export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  images?: SpotifyImage[];
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  album_type?: string; // album | single | compilation
  artists?: SpotifyArtist[];
  images?: SpotifyImage[];
  release_date?: string;
  total_tracks?: number;
  tracks?: SpotifyPaging<SpotifyTrack>;
}

export interface SpotifyTrack {
  id: string | null;
  name: string;
  type?: string; // "track", or "episode" inside playlists
  artists?: SpotifyArtist[];
  album?: SpotifyAlbum;
  duration_ms?: number;
  is_local?: boolean;
}

// A playlist entry. The February 2026 API renamed `track` to `item`; both are read.
export interface SpotifyPlaylistEntry {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description?: string | null;
  collaborative?: boolean;
  images?: SpotifyImage[] | null;
  owner?: { id: string; display_name?: string | null };
  // `items` (formerly `tracks`): a page of entries for playlists the user owns or
  // collaborates on, otherwise just a count, or nothing.
  items?: Partial<SpotifyPaging<SpotifyPlaylistEntry>> | null;
  tracks?: Partial<SpotifyPaging<SpotifyPlaylistEntry>> | null;
}

export interface SpotifyPaging<T> {
  items: T[];
  next: string | null;
  total?: number;
}

export interface SpotifyProfile {
  id: string;
  display_name?: string | null;
}

export interface SpotifySearchResults {
  tracks?: SpotifyPaging<SpotifyTrack | null>;
  artists?: SpotifyPaging<SpotifyArtist | null>;
  albums?: SpotifyPaging<SpotifyAlbum | null>;
  playlists?: SpotifyPaging<SpotifyPlaylist | null>;
}

type Params = Record<string, string | number | undefined>;

export class SpotifyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SpotifyError";
  }
}

export class SpotifyClient {
  constructor(
    private readonly auth: Pick<SpotifyAuth, "accessToken" | "refresh">,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get<T>(pathname: string, params: Params = {}): Promise<T> {
    const url = new URL(API_BASE + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.getUrl<T>(url);
  }

  // Collect a paged list, following `next` links up to `max` items. `pick` finds the
  // page in bodies that wrap it (e.g. /me/following → { artists: {…} }).
  async pages<T>(
    pathname: string,
    params: Params,
    max: number,
    pick: (body: unknown) => SpotifyPaging<T> = (body) => body as SpotifyPaging<T>
  ): Promise<T[]> {
    const first = pick(await this.get<unknown>(pathname, params));
    return this.collect(first, max, pick);
  }

  // The rest of a list whose first page came embedded in another object.
  async collect<T>(
    first: SpotifyPaging<T>,
    max: number,
    pick: (body: unknown) => SpotifyPaging<T> = (body) => body as SpotifyPaging<T>
  ): Promise<T[]> {
    const items = [...first.items];
    let next = first.next;
    while (next && items.length < max) {
      const page = pick(await this.getUrl<unknown>(new URL(next)));
      items.push(...page.items);
      next = page.next;
    }
    return items.slice(0, max);
  }

  private async getUrl<T>(url: URL): Promise<T> {
    if (url.origin !== new URL(API_BASE).origin) throw new SpotifyError(`Unexpected paging URL ${url.origin}`, 502);
    let response = await this.send(url, await this.auth.accessToken());
    if (response.status === 401) response = await this.send(url, await this.auth.refresh());
    if (response.status === 429) {
      const wait = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      if (Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_S) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 0) * 1000));
        response = await this.send(url, await this.auth.accessToken());
      }
    }
    if (!response.ok) throw new SpotifyError(`Spotify: ${await errorMessage(response)}`, response.status);
    return (await response.json()) as T;
  }

  private send(url: URL, token: string): Promise<Response> {
    return this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  }
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 429) return "rate limited, try again in a minute";
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    if (message) return `${message} (${response.status})`;
  } catch {
    // not JSON
  }
  return `request failed (${response.status})`;
}
