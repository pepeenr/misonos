import { createContext, Script } from "node:vm";
import { Innertube, Log, Platform } from "youtubei.js";
import { getCookieString } from "./cookieAuth.js";
import { requestYtDlpUpdate, resolveWithYtDlp, withCookieFile, YtDlpMissingError, type YtDlpStream } from "./ytdlp.js";

// Silence non-fatal parser warnings (TicketEvent submenu types YT keeps adding).
// Real failures still throw and reach our endpoint handlers.
Log.setLevel(Log.Level.NONE);

// youtubei.js v17 no longer ships a default JS evaluator for player decipher.
// Wire one up using Node's vm module so signature deciphering works.
const evalContext = createContext({});
Platform.load({
  ...Platform.shim,
  eval: (data: { output: string }) => {
    const script = new Script(`(function() {\n${data.output}\n})()`);
    return script.runInContext(evalContext, { timeout: 5000 });
  }
});

export interface YtmSearchTrack {
  videoId: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export interface YtmStreamInfo {
  url: string;
  mimeType?: string;
}

let client: Innertube | undefined;
let initPromise: Promise<Innertube> | null = null;

export async function getClient(): Promise<Innertube> {
  if (client) return client;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Always run anonymously — restored OAuth sessions cause player/next calls
    // to 400, and we don't currently use auth for browse anyway.
    const yt = await Innertube.create({ retrieve_player: true });
    client = yt;
    return yt;
  })().finally(() => { initPromise = null; });
  return initPromise;
}

interface RawSongResult {
  id?: string;
  title?: string | { text?: string };
  artists?: { name?: string }[];
  album?: { name?: string } | string;
  duration?: { seconds?: number; text?: string };
  thumbnails?: { url: string }[];
  thumbnail?: { contents?: { url: string }[] };
}

export async function searchSongs(query: string, limit = 30): Promise<YtmSearchTrack[]> {
  const yt = await getClient();
  const music = yt.music;
  const results = await music.search(query, { type: "song" });
  const items: RawSongResult[] = readArray(results, ["contents", "items", "songs"]);
  return items
    .map(normalizeSong)
    .filter((item): item is YtmSearchTrack => item !== null)
    .slice(0, limit);
}

// A resolved URL is good until its `expire` (about 6 h out). Sonos asks again when it
// opens the stream, and a playlist enqueue asks for the same tracks, so keep them.
const STREAM_CACHE_MAX = 500;
const streamCache = new Map<string, { stream: YtmStreamInfo; until: number }>();
const pendingStreams = new Map<string, Promise<YtmStreamInfo>>();

export async function getStreamUrl(videoId: string): Promise<YtmStreamInfo> {
  const cached = streamCache.get(videoId);
  if (cached && cached.until > Date.now()) {
    // Still check it: a new public IP (the URL is bound to it) voids every cached URL.
    if (await urlIsPlayable(cached.stream.url)) return cached.stream;
    streamCache.delete(videoId);
  }
  const pending = pendingStreams.get(videoId);
  if (pending) return pending;
  const job = resolveStream(videoId)
    .then((stream) => {
      rememberStream(videoId, stream);
      return stream;
    })
    .finally(() => pendingStreams.delete(videoId));
  pendingStreams.set(videoId, job);
  return job;
}

function rememberStream(videoId: string, stream: YtmStreamInfo): void {
  const now = Date.now();
  for (const [key, entry] of streamCache) {
    if (entry.until <= now || streamCache.size >= STREAM_CACHE_MAX) streamCache.delete(key);
  }
  streamCache.set(videoId, { stream, until: cacheUntil(stream.url, now) });
}

/** Ten minutes before the URL's `expire`, so a stream Sonos opens late still lasts. */
export function cacheUntil(url: string, now = Date.now()): number {
  const expire = Number(new URL(url).searchParams.get("expire"));
  const fallback = now + 60 * 60 * 1000;
  if (!Number.isFinite(expire) || expire <= 0) return fallback;
  return Math.max(now, expire * 1000 - 10 * 60 * 1000);
}

interface StreamAttempt {
  label: string;
  playerClient?: string;
  signedIn?: boolean;
}

// visionos needs no JS challenges and gets no pre-roll ad, so it answers in ~2–4 s with
// a URL that streams at once. yt-dlp's own default clients come next: slower (they wait
// out the ad) but they are what yt-dlp keeps working. If visionos keeps failing, skip
// it for a while rather than paying for it on every track.
const FAST_CLIENT = "visionos";
const FAST_CLIENT_STRIKES = 3;
const FAST_CLIENT_REST_MS = 30 * 60 * 1000;
let fastClientStrikes = 0;
let fastClientRestUntil = 0;
// A longer ad than this would outlast the bridge's patience; try the next attempt.
const MAX_AD_WAIT_MS = 15_000;

async function resolveStream(videoId: string): Promise<YtmStreamInfo> {
  const attempts: StreamAttempt[] = [];
  if (Date.now() >= fastClientRestUntil) attempts.push({ label: FAST_CLIENT, playerClient: FAST_CLIENT });
  attempts.push({ label: "default clients" });
  // Podcast episodes (and some gated tracks) stream only for a signed-in session.
  if (getCookieString()) attempts.push({ label: "signed in", signedIn: true });

  let lastError: Error | undefined;
  for (const attempt of attempts) {
    const started = Date.now();
    try {
      const stream = await runAttempt(videoId, attempt);
      if (await waitUntilPlayable(stream)) {
        if (attempt.playerClient === FAST_CLIENT) fastClientStrikes = 0;
        console.log(`[ytmusic] ${videoId}: yt-dlp (${attempt.label}) itag ${stream.formatId ?? "?"} in ${Date.now() - started} ms`);
        return { url: stream.url, mimeType: stream.mimeType };
      }
      lastError = new Error(`yt-dlp (${attempt.label}) returned a URL that failed the HEAD check`);
    } catch (error) {
      if (error instanceof YtDlpMissingError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    console.log(`[ytmusic] ${videoId}: yt-dlp (${attempt.label}) failed after ${Date.now() - started} ms: ${lastError.message}`);
    if (attempt.playerClient === FAST_CLIENT && ++fastClientStrikes >= FAST_CLIENT_STRIKES) {
      fastClientStrikes = 0;
      fastClientRestUntil = Date.now() + FAST_CLIENT_REST_MS;
      console.log(`[ytmusic] ${FAST_CLIENT} keeps failing; using yt-dlp's default clients for ${FAST_CLIENT_REST_MS / 60_000} min`);
    }
  }
  requestYtDlpUpdate();
  throw lastError ?? new Error("No stream found");
}

function runAttempt(videoId: string, attempt: StreamAttempt): Promise<YtDlpStream> {
  const cookie = attempt.signedIn ? getCookieString() : null;
  if (!cookie) return resolveWithYtDlp(videoId, { playerClient: attempt.playerClient });
  return withCookieFile(cookie, (cookieFile) => resolveWithYtDlp(videoId, { playerClient: attempt.playerClient, cookieFile }));
}

/** Sits out the pre-roll ad, then HEAD-checks the URL so a bad one never reaches Sonos. */
async function waitUntilPlayable(stream: YtDlpStream): Promise<boolean> {
  const adWaitMs = stream.availableAt ? stream.availableAt * 1000 - Date.now() : 0;
  if (adWaitMs > MAX_AD_WAIT_MS) return false;
  if (adWaitMs > 0) await sleep(adWaitMs);
  // available_at is whole seconds and googlevideo's clock is its own: allow a little slack.
  for (let check = 0; check < 3; check++) {
    if (check > 0) await sleep(1500);
    if (await urlIsPlayable(stream.url)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function urlIsPlayable(url: string): Promise<boolean> {
  const controller = new AbortController();
  // Bound the worst case: a gated client whose URL hangs shouldn't add 5s to the
  // time-to-first-byte that Sonos is waiting on.
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        accept: "*/*",
        origin: "https://music.youtube.com",
        referer: "https://music.youtube.com/"
      },
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getTrackMetadata(videoId: string): Promise<YtmSearchTrack | null> {
  const yt = await getClient();
  const info = await yt.music.getInfo(videoId);
  const basic = info.basic_info;
  if (!basic) return null;
  return {
    videoId,
    title: basic.title ?? "Unknown",
    artist: basic.author ?? undefined,
    album: undefined,
    durationSeconds: basic.duration ?? undefined,
    thumbnailUrl: pickBestThumbnail(basic.thumbnail)
  };
}

function normalizeSong(item: RawSongResult | unknown): YtmSearchTrack | null {
  if (!item || typeof item !== "object") return null;
  const record = item as RawSongResult;
  const videoId = record.id ?? extractId(record);
  if (!videoId) return null;
  const title = typeof record.title === "string" ? record.title : record.title?.text ?? "Unknown";
  const artist = record.artists?.[0]?.name;
  const album = typeof record.album === "string" ? record.album : record.album?.name;
  const durationSeconds = record.duration?.seconds ?? parseDuration(record.duration?.text);
  return {
    videoId,
    title,
    artist,
    album,
    durationSeconds,
    thumbnailUrl: pickBestThumbnail(record.thumbnails ?? record.thumbnail?.contents)
  };
}

function readArray(root: unknown, keys: string[]): RawSongResult[] {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value) && value.length > 0 && hasIdLike(value[0])) return value as RawSongResult[];
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return [];
}

function hasIdLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" || record.video_id !== undefined || typeof record.videoId === "string";
}

function extractId(record: RawSongResult): string | undefined {
  const generic = record as Record<string, unknown>;
  const value = generic.videoId ?? generic.video_id;
  return typeof value === "string" ? value : undefined;
}

function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const parts = text.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function pickBestThumbnail(thumbs: unknown): string | undefined {
  if (!Array.isArray(thumbs)) return undefined;
  let best: { url: string; width?: number } | undefined;
  for (const candidate of thumbs) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as { url?: string; width?: number };
    if (typeof record.url !== "string") continue;
    if (!best || (record.width ?? 0) > (best.width ?? 0)) best = { url: record.url, width: record.width };
  }
  return best?.url;
}
