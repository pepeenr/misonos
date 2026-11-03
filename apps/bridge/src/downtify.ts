import http from "node:http";
import https from "node:https";

// Downtify (github.com/henriquesebastiao/downtify) downloads songs with yt-dlp into the
// folder Navidrome scans, and asks Navidrome to scan after each one. MiSonos talks to it
// as a paired app: Downtify's Settings → Apps shows a code, MiSonos trades it for a
// device token, and that token may look links up and ask for downloads, nothing more.

export interface DowntifyEndpoint {
  url: string;
  /** Sent as the Host header, for a reverse proxy that routes by name. */
  host?: string;
}

/** A song as Downtify resolves a link. */
export interface DowntifySong {
  /** The YouTube video id, for YouTube links. */
  song_id?: string;
  name?: string;
  artists?: string[];
  album_name?: string;
  /** Seconds. */
  duration?: number;
  url?: string;
}

export interface DowntifyPairing {
  token: string;
  device?: { id?: string; name?: string };
  user?: { username?: string };
}

export class DowntifyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DowntifyError";
  }
}

// Downtify answers a download only once yt-dlp and ffmpeg are done with it.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class DowntifyClient {
  constructor(private readonly endpoint: DowntifyEndpoint, private readonly token?: string) {}

  pair(code: string, deviceName: string): Promise<DowntifyPairing> {
    return this.call<DowntifyPairing>("POST", "/api/auth/pair", { body: { code, device_name: deviceName, platform: "misonos" } });
  }

  /** The songs behind a link: one for a video, each of them for a playlist. */
  async resolve(link: string): Promise<DowntifySong[]> {
    const result = await this.call<DowntifySong | DowntifySong[]>("GET", `/api/url?url=${encodeURIComponent(link)}`);
    return Array.isArray(result) ? result : [result];
  }

  /** What YouTube Music's radio plays after a song: its Mix, found from the artist and title. */
  async similar(artist: string, track: string, limit: number): Promise<DowntifySong[]> {
    const query = new URLSearchParams({ artist, track, limit: String(limit) });
    const result = await this.call<{ tracks?: DowntifySong[] }>("GET", `/api/similar/tracks?${query}`);
    return result.tracks ?? [];
  }

  /** Downloads `song`, and answers with its file name once it's on disk. */
  download(song: DowntifySong): Promise<string> {
    const videoId = song.song_id && VIDEO_ID.test(song.song_id) ? song.song_id : undefined;
    const url = song.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    const query = new URLSearchParams({ url, client_id: "misonos" });
    // youtube_id pins the video itself, so Downtify doesn't match it to another upload.
    // No playlist_name: Downtify's playlists only take songs with a Spotify id, so a
    // YouTube song never reached its M3U. The bridge keeps the playlist in Navidrome.
    return this.call<string>("POST", `/api/download/url?${query}`, {
      body: videoId ? { youtube_id: videoId } : {},
      timeoutMs: DOWNLOAD_TIMEOUT_MS
    });
  }

  // node:http rather than fetch, which won't send a Host header of its own.
  private call<T>(method: string, path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const target = new URL(path, this.endpoint.url);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.endpoint.host) headers.Host = this.endpoint.host;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const transport = target.protocol === "https:" ? https : http;
    return new Promise<T>((resolve, reject) => {
      const request = transport.request(
        target,
        { method, headers, servername: this.endpoint.host, timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            let data: unknown;
            try {
              data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              data = undefined;
            }
            if (status >= 400 || data === undefined) {
              reject(new DowntifyError(errorDetail(data) ?? `Downtify answered ${status}`, status || 502));
              return;
            }
            resolve(data as T);
          });
        }
      );
      request.on("timeout", () => request.destroy(new DowntifyError("Downtify took too long to answer", 504)));
      request.on("error", (error) => {
        reject(error instanceof DowntifyError ? error : new DowntifyError(`Can't reach Downtify: ${error.message}`, 502));
      });
      request.end(body);
    });
  }
}

// FastAPI's errors: {"detail": "…"}, or a list of {msg} for a bad request.
function errorDetail(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((entry) => (entry as { msg?: unknown })?.msg).filter((msg): msg is string => typeof msg === "string");
    if (messages.length) return messages.join("; ");
  }
  return undefined;
}
