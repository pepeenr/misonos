import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NowPlaying, PlaybackMode, SourceBrowseItem, YouTubeImportJob, YouTubeImportStatus, YouTubeLinkPreview, YouTubeSongNames } from "@misonos/sonos-protocol";
import { DowntifyClient, DowntifyError, type DowntifyEndpoint, type DowntifyPairing, type DowntifySong } from "./downtify.js";

// Paste a YouTube link, hear it on the speakers. Downtify downloads each song into the
// Navidrome library; once Navidrome has it, MiSonos adds it to one Navidrome playlist
// ("YouTube") and plays it from Navidrome like any other track. The first song plays as
// soon as it's in, and the rest join the queue behind it as they arrive.

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
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// The longest file or folder name Downtify can write, in UTF-8 bytes: Linux allows 255,
// less room for the ".webm.part" yt-dlp downloads into. Downtify doesn't shorten names,
// so a longer one fails with "[Errno 36] Filename too long".
export const FILE_NAME_BYTES = 240;
// What a song whose YouTube names don't fit in a file name is saved as, with its video
// id for a title (as `yt-dlp --parse-metadata "[%(id)s]:%(title)s"` would).
export const FALLBACK_ARTIST = "YouTube";
// Characters that print as nothing: Hangul fillers, the blank Braille cell, zero-width
// spaces. Uploads use them for "blank" names.
const INVISIBLE = /[\s\u115F\u1160\u3164\uFFA0\u2800\u200B-\u200D\u2060\uFEFF]/gu;

export interface DowntifyApi {
  pair(code: string, deviceName: string): Promise<DowntifyPairing>;
  resolve(link: string): Promise<DowntifySong[]>;
  similar(artist: string, track: string, limit: number): Promise<DowntifySong[]>;
  download(song: DowntifySong, names?: YouTubeSongNames): Promise<string>;
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
  /** Adds Navidrome tracks to the playlist. */
  addToPlaylist: (trackIds: string[]) => Promise<unknown>;
  /** Streams a YouTube video on a group, saving nothing (the YouTube Music source). */
  playVideo?: (videoId: string, groupId: string, mode: PlaybackMode) => Promise<NowPlaying>;
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

  /**
   * Starts getting a link's songs; the job reports its progress through onChange. A
   * single video can be saved under an artist and title of its own (`names`).
   */
  async start(request: { url: string; groupId?: string; mode?: PlaybackMode; names?: YouTubeSongNames }): Promise<YouTubeImportJob> {
    const endpoint = this.requireEndpoint();
    if (!isYouTubeLink(request.url)) throw new YouTubeImportError("That isn't a YouTube link", 400);
    const names = givenNames(request.names);
    if (names) {
      if (youtubeLink(request.url).kind !== "video") {
        throw new YouTubeImportError("Only a single video can be saved under an artist and title of its own", 400);
      }
      const fileName = [names.artist, names.title].filter(Boolean).join(" - ");
      if (!fitsFileName(fileName)) throw new YouTubeImportError("That artist and title are too long for a file name", 400);
    }
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
    void this.run(job, this.client(endpoint, pairing.token), mode, names);
    return reply;
  }

  /**
   * What a link is, for choosing between playing and downloading it: its kind, the
   * video Play would play, and, for a single video, YouTube's own names (from Downtify,
   * when paired) and what a download is saved as when those are too long for a file.
   */
  async preview(url: string): Promise<YouTubeLinkPreview> {
    if (!isYouTubeLink(url)) throw new YouTubeImportError("That isn't a YouTube link", 400);
    const link = youtubeLink(url);
    const preview: YouTubeLinkPreview = { kind: link.kind, videoId: videoIdOf(url) };
    const pairing = this.options.endpoint && link.kind === "video" ? await this.readPairing() : undefined;
    if (!this.options.endpoint || !pairing) return preview;
    let song: DowntifySong | undefined;
    try {
      song = (await this.client(this.options.endpoint, pairing.token).resolve(link.resolve))[0];
    } catch {
      return preview;
    }
    if (!song) return preview;
    const saved = namesToSave(song);
    return {
      ...preview,
      title: song.name,
      artist: artistOf(song),
      durationSeconds: song.duration,
      ...(saved.shortened ? { shortenedTo: saved.names } : {})
    };
  }

  /**
   * Plays a link's video on a group without saving it: streamed through the YouTube
   * Music source. A Mix link plays its song; a playlist link with no video can't play.
   */
  async playLink(request: { url: string; groupId?: string; mode?: PlaybackMode }): Promise<NowPlaying> {
    if (!isYouTubeLink(request.url)) throw new YouTubeImportError("That isn't a YouTube link", 400);
    if (!this.options.playVideo) throw new YouTubeImportError("Playing YouTube links isn't set up", 503);
    if (!request.groupId) throw new YouTubeImportError("Pick a Sonos room to play it on", 400);
    const videoId = videoIdOf(request.url);
    if (!videoId) throw new YouTubeImportError("Play takes a single video; Download gets the whole playlist", 400);
    try {
      return await this.options.playVideo(videoId, request.groupId, request.mode === "end" ? "end" : "replace");
    } catch (error) {
      throw new YouTubeImportError(`Couldn't play it: ${errorText(error)}`, 502);
    }
  }

  private async run(job: YouTubeImportJob, client: DowntifyApi, mode: "replace" | "end", asked?: YouTubeSongNames): Promise<void> {
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
          // The names asked for, or YouTube's own unless they don't fit in a file name.
          const saved = namesToSave(song, asked);
          if (saved.shortened) job.note ??= `YouTube's name for a song was too long for a file, so it's saved as “${saved.names.artist ?? artistOf(song)} - ${saved.names.title ?? song.name}”.`;
          const named: DowntifySong = {
            ...song,
            name: saved.names.title ?? song.name,
            artists: saved.names.artist ? [saved.names.artist] : song.artists
          };
          track.title = named.name || track.title;
          track.artist = artistOf(named) ?? track.artist;
          this.emit(job);
          await client.download(song, saved.names.artist || saved.names.title ? saved.names : undefined);
          track.status = "finding";
          this.emit(job);
          const trackId = await this.find(named);
          // A song that plays but missed the playlist is still worth having: say so once.
          await this.options.addToPlaylist([trackId]).catch((error: unknown) => {
            job.note ??= `Couldn't add songs to the ${this.options.playlist} playlist: ${errorText(error)}.`;
          });
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
  const video = videoIdOf(text);
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

/**
 * The video a link points at: watch?v=, youtu.be/, /shorts/, /live/, or the song a
 * Mix (list=RD + its id) was started from. Undefined for a plain playlist.
 */
export function videoIdOf(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const list = url.searchParams.get("list") ?? "";
  const candidates = [
    url.searchParams.get("v"),
    /youtu\.be$/i.test(url.hostname) ? url.pathname.slice(1) : undefined,
    /^\/(shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[2],
    isRadioMix(list) ? list.slice(2) : undefined
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && VIDEO_ID.test(candidate)));
}

/** Fits in a file name Downtify can write (see FILE_NAME_BYTES). */
export function fitsFileName(name: string): boolean {
  return Buffer.byteLength(name, "utf8") <= FILE_NAME_BYTES;
}

/** Prints as something: not empty, and not only invisible characters. */
export function isVisibleName(name: string | undefined): boolean {
  return Boolean(name && name.replace(INVISIBLE, ""));
}

/**
 * The artist and title a song is saved under: those asked for, else YouTube's own.
 * YouTube's own are replaced when they make a file or folder name too long, or print
 * as nothing: the title by the video id, the artist by FALLBACK_ARTIST. Downtify names
 * the file "<artists> - <title>" (its default template) inside a folder of the album
 * artist.
 */
export function namesToSave(song: DowntifySong, asked?: YouTubeSongNames): { names: YouTubeSongNames; shortened: boolean } {
  const names: YouTubeSongNames = { ...givenNames(asked) };
  const folder = () => names.artist ?? song.album_artist ?? song.artists?.[0] ?? "";
  const file = () => `${names.artist ?? (song.artists ?? []).join(", ")} - ${names.title ?? song.name ?? ""}`;
  let shortened = false;
  // A missing name is Downtify's to fill ("Unknown"); one that's there must print.
  const blank = (name: string | undefined) => Boolean(name) && !isVisibleName(name);
  if (!names.title && song.song_id && (!fitsFileName(file()) || blank(song.name))) {
    names.title = song.song_id;
    shortened = true;
  }
  if (!names.artist && (!fitsFileName(folder()) || !fitsFileName(file()) || blank(folder()))) {
    names.artist = FALLBACK_ARTIST;
    shortened = true;
  }
  return { names, shortened };
}

// The names a request gives, trimmed; undefined when it gives none.
function givenNames(names?: YouTubeSongNames): YouTubeSongNames | undefined {
  const artist = typeof names?.artist === "string" ? names.artist.trim() : "";
  const title = typeof names?.title === "string" ? names.title.trim() : "";
  if (!artist && !title) return undefined;
  return { ...(artist ? { artist } : {}), ...(title ? { title } : {}) };
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
