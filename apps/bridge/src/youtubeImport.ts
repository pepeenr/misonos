import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NowPlaying, PlaybackMode, SourceBrowseItem, YouTubeImportJob, YouTubeImportStatus } from "@misonos/sonos-protocol";
import { DowntifyClient, DowntifyError, type DowntifyEndpoint, type DowntifyPairing, type DowntifySong } from "./downtify.js";

// Paste a YouTube link, hear it on the speakers. Downtify downloads each song into the
// Navidrome library and adds it to one playlist ("YouTube"); once Navidrome has it,
// MiSonos plays it from Navidrome like any other track. The first song plays as soon as
// it's in, and the rest join the queue behind it as they arrive.

// How long a downloaded song may take to show up in Navidrome's search: Downtify asks
// Navidrome to scan, and Navidrome's own file watcher would notice it too.
const FIND_TIMEOUT_MS = 90_000;
const FIND_POLL_MS = 2_000;
// Imports kept for GET /api/youtube/imports.
const KEEP_JOBS = 10;
// A Mix is endless radio: the linked song comes with this many of the songs after it.
export const MIX_SONGS = 10;
// A song's length in Navidrome can be a second or two off YouTube's.
const DURATION_SLACK_S = 3;
const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/i;

export interface DowntifyApi {
  pair(code: string, deviceName: string): Promise<DowntifyPairing>;
  resolve(link: string): Promise<DowntifySong[]>;
  similar(artist: string, track: string, limit: number): Promise<DowntifySong[]>;
  download(song: DowntifySong, playlist: string): Promise<string>;
}

export interface YouTubeImporterOptions {
  endpoint?: DowntifyEndpoint;
  playlist: string;
  /** The file the Downtify token is kept in. */
  pairingPath: string;
  /** Navidrome's search. */
  search: (query: string) => Promise<SourceBrowseItem[]>;
  /** Plays Navidrome tracks on a group. */
  play: (trackIds: string[], groupId: string, mode: PlaybackMode) => Promise<NowPlaying>;
  onChange: (job: YouTubeImportJob) => void;
  client?: (endpoint: DowntifyEndpoint, token?: string) => DowntifyApi;
  findTimeoutMs?: number;
  findPollMs?: number;
}

interface SavedPairing {
  token: string;
  username?: string;
  pairedAt: string;
}

export class YouTubeImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "YouTubeImportError";
  }
}

export class YouTubeImporter {
  private readonly jobs: YouTubeImportJob[] = [];

  constructor(private readonly options: YouTubeImporterOptions) {}

  async status(): Promise<YouTubeImportStatus> {
    const pairing = await this.readPairing();
    return {
      available: Boolean(this.options.endpoint),
      paired: Boolean(this.options.endpoint && pairing),
      username: pairing?.username,
      playlist: this.options.playlist,
      mixSongs: MIX_SONGS
    };
  }

  /** Trades a code from Downtify's Settings → Apps for a token, and keeps it. */
  async pair(code: string): Promise<YouTubeImportStatus> {
    const endpoint = this.requireEndpoint();
    let pairing: DowntifyPairing;
    try {
      pairing = await this.client(endpoint).pair(code.replace(/\s+/g, ""), "MiSonos");
    } catch (error) {
      throw asImportError(error);
    }
    if (!pairing.token) throw new YouTubeImportError("Downtify sent no token", 502);
    const saved: SavedPairing = { token: pairing.token, username: pairing.user?.username, pairedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.options.pairingPath), { recursive: true });
    await writeFile(this.options.pairingPath, JSON.stringify(saved), { mode: 0o600 });
    return this.status();
  }

  /** Forgets the token. Downtify still lists the app until it's removed there. */
  async unpair(): Promise<YouTubeImportStatus> {
    await rm(this.options.pairingPath, { force: true });
    return this.status();
  }

  recent(): YouTubeImportJob[] {
    return [...this.jobs];
  }

  /** Starts getting a link's songs; the job reports its progress through onChange. */
  async start(request: { url: string; groupId?: string; mode?: PlaybackMode }): Promise<YouTubeImportJob> {
    const endpoint = this.requireEndpoint();
    if (!isYouTubeLink(request.url)) throw new YouTubeImportError("That isn't a YouTube link", 400);
    const pairing = await this.readPairing();
    if (!pairing) throw new YouTubeImportError("Pair MiSonos with Downtify in Settings first", 409);
    const job: YouTubeImportJob = {
      id: randomUUID(),
      url: request.url,
      groupId: request.groupId,
      status: "resolving",
      tracks: [],
      startedAt: new Date().toISOString()
    };
    this.jobs.unshift(job);
    this.jobs.splice(KEEP_JOBS);
    const mode = request.mode === "end" ? "end" : "replace";
    // As it starts: the run goes on changing `job` itself.
    const reply = structuredClone(job);
    void this.run(job, this.client(endpoint, pairing.token), mode);
    return reply;
  }

  private async run(job: YouTubeImportJob, client: DowntifyApi, mode: "replace" | "end"): Promise<void> {
    this.emit(job);
    try {
      const link = youtubeLink(job.url);
      let songs = (await client.resolve(link.resolve)).filter((song) => song.url || song.song_id);
      if (songs.length === 0) throw new YouTubeImportError("Downtify found no songs at that link", 404);
      if (link.kind === "mix") songs = await this.withMix(client, songs[0], job);
      job.tracks = songs.map((song) => ({ title: song.name || "Untitled", artist: artistOf(song), status: "waiting" }));
      job.status = "running";
      this.emit(job);
      let started = false;
      for (const [index, listed] of songs.entries()) {
        const track = job.tracks[index];
        try {
          track.status = "downloading";
          this.emit(job);
          // A playlist lists its songs as the playlist names them; the download is
          // tagged from the video's own details, and that's what Navidrome will show.
          const own = songs.length > 1 ? (await client.resolve(watchUrl(listed)).catch(() => []))[0] : undefined;
          const song: DowntifySong = { ...listed, ...own };
          track.title = song.name || track.title;
          track.artist = artistOf(song) ?? track.artist;
          await client.download(song, this.options.playlist);
          track.status = "finding";
          this.emit(job);
          const trackId = await this.find(song);
          if (!job.groupId) {
            track.status = "saved";
          } else {
            await this.options.play([trackId], job.groupId, started ? "end" : mode);
            track.status = started || mode === "end" ? "queued" : "playing";
            started = true;
          }
        } catch (error) {
          track.status = "failed";
          track.error = errorText(error);
        }
        this.emit(job);
      }
      const failed = job.tracks.filter((track) => track.status === "failed");
      job.status = failed.length === job.tracks.length ? "failed" : "done";
      if (job.status === "failed") job.error = failed[0]?.error;
    } catch (error) {
      job.status = "failed";
      job.error = errorText(error);
    }
    job.finishedAt = new Date().toISOString();
    this.emit(job);
  }

  // The linked song, then what YouTube Music's radio plays after it. Downtify finds the
  // radio from the artist and title, so it can differ a little from the Mix on YouTube.
  private async withMix(client: DowntifyApi, seed: DowntifySong, job: YouTubeImportJob): Promise<DowntifySong[]> {
    try {
      const after = await client.similar(seed.artists?.[0] ?? "", seed.name ?? "", MIX_SONGS);
      const seen = new Set([seed.song_id]);
      const more = after.filter((song) => song.song_id && !seen.has(song.song_id) && seen.add(song.song_id));
      return [seed, ...more.slice(0, MIX_SONGS)];
    } catch (error) {
      job.note = `Only the song: its Mix couldn't be read (${errorText(error)}).`;
      return [seed];
    }
  }

  // Waits for Navidrome to list the downloaded song, and answers with its track id.
  private async find(song: DowntifySong): Promise<string> {
    const title = song.name?.trim();
    if (!title) throw new Error("Downtify gave the song no title to look for");
    const deadline = Date.now() + (this.options.findTimeoutMs ?? FIND_TIMEOUT_MS);
    for (;;) {
      const items = await this.options.search(title).catch(() => [] as SourceBrowseItem[]);
      const match = pickTrack(items, song);
      if (match) return match.id;
      if (Date.now() >= deadline) throw new Error("Downloaded, but Navidrome hasn't picked it up yet");
      await sleep(this.options.findPollMs ?? FIND_POLL_MS);
    }
  }

  private emit(job: YouTubeImportJob): void {
    try {
      this.options.onChange(job);
    } catch {
      // A listener's trouble doesn't stop the import.
    }
  }

  private client(endpoint: DowntifyEndpoint, token?: string): DowntifyApi {
    return this.options.client?.(endpoint, token) ?? new DowntifyClient(endpoint, token);
  }

  private requireEndpoint(): DowntifyEndpoint {
    if (!this.options.endpoint) throw new YouTubeImportError("Downtify isn't set up (MISONOS_DOWNTIFY_URL)", 503);
    return this.options.endpoint;
  }

  private async readPairing(): Promise<SavedPairing | undefined> {
    try {
      const saved = JSON.parse(await readFile(this.options.pairingPath, "utf8")) as Partial<SavedPairing>;
      return typeof saved.token === "string" && saved.token ? (saved as SavedPairing) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function isYouTubeLink(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && YOUTUBE_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * What a link is, and the link to ask Downtify about. A video opened from a playlist
 * (watch?v=…&list=PL…) means the playlist; Downtify alone would take just the video.
 * A Mix (list=RD…, YouTube's endless radio for a song) is the song and what follows it.
 */
export function youtubeLink(text: string): { kind: "video" | "playlist" | "mix"; resolve: string } {
  const url = new URL(text.trim());
  const list = url.searchParams.get("list");
  const video = url.searchParams.get("v") ?? (/youtu\.be$/i.test(url.hostname) ? url.pathname.slice(1) : undefined);
  if (!list) return { kind: "video", resolve: text.trim() };
  if (isRadioMix(list)) {
    // A song's own Mix is "RD" + its video id.
    const seed = video || (/^RD[A-Za-z0-9_-]{11}$/.test(list) ? list.slice(2) : undefined);
    return seed ? { kind: "mix", resolve: `https://www.youtube.com/watch?v=${seed}` } : { kind: "video", resolve: text.trim() };
  }
  return { kind: "playlist", resolve: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` };
}

// "RD…" lists are generated radio; "RDCLAK5uy_…" ones are YouTube Music's curated playlists.
function isRadioMix(list: string): boolean {
  return list.startsWith("RD") && !list.startsWith("RDCLAK5uy_");
}

/** The Navidrome track that is this song: same title and length, the artist breaking a tie. */
export function pickTrack(items: SourceBrowseItem[], song: DowntifySong): SourceBrowseItem | undefined {
  const title = normalize(song.name ?? "");
  if (!title) return undefined;
  const candidates = items.filter((item) => {
    if (item.kind !== "playable" || normalize(item.title) !== title) return false;
    if (!song.duration || !item.durationSeconds) return true;
    return Math.abs(item.durationSeconds - song.duration) <= DURATION_SLACK_S;
  });
  const artists = (song.artists ?? []).map(normalize).filter(Boolean);
  return candidates.find((item) => artists.some((artist) => normalize(item.artist ?? "").includes(artist))) ?? candidates[0];
}

// Case, accents, spaces and punctuation aside.
function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function watchUrl(song: DowntifySong): string {
  return song.song_id ? `https://www.youtube.com/watch?v=${song.song_id}` : song.url ?? "";
}

function artistOf(song: DowntifySong): string | undefined {
  return song.artists?.length ? song.artists.join(", ") : undefined;
}

function asImportError(error: unknown): YouTubeImportError {
  if (error instanceof DowntifyError) {
    return new YouTubeImportError(error.message, error.status >= 400 && error.status < 500 ? error.status : 502);
  }
  return new YouTubeImportError(errorText(error), 502);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
