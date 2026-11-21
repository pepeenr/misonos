import type { NowPlaying, SourceBrowseItem } from "@misonos/sonos-protocol";

// Song radio: songs like one song, the way "Start radio" works in a music app.
//
// YouTube Music makes the list: its radio for a song is the "RDAMVM" + video id
// playlist. The songs then play from Spotify or Navidrome, found there by artist and
// title, because YouTube gates its own streams behind bot checks while those two play
// reliably on Sonos. A song from YouTube Music itself keeps its radio on YouTube Music.

export interface TrackRef {
  sourceId: string;
  trackId: string;
}

/** The song a radio starts from: what it's called, and where it plays from when known. */
export interface RadioSeed {
  title: string;
  artist?: string;
  ref?: TrackRef;
}

/** The source whose radio makes the list. */
export const RADIO_LIST_SOURCE = "youtube-music";
/** Where the radio's songs are looked up to play, in this order unless the seed is from one. */
const PLAY_SOURCES = ["spotify", "navidrome"];
const SOURCE_NAMES: Record<string, string> = { spotify: "Spotify", navidrome: "Navidrome", "youtube-music": "YouTube Music" };
/** How many songs a radio queues: about an hour and a half. */
export const RADIO_SONGS = 25;
const SEARCH_CONCURRENCY = 8;

export class SongRadioError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SongRadioError";
  }
}

export interface SongRadioSources {
  browse(sourceId: string, id: string): Promise<SourceBrowseItem[]>;
  /** Songs only. */
  search(sourceId: string, query: string): Promise<SourceBrowseItem[]>;
  /** The sources that are switched on and answer. */
  available(): Promise<string[]>;
}

export interface SongRadioList {
  /** The radio's songs, in its order, without the seed. */
  refs: TrackRef[];
  /** The sources they play from. */
  from: string[];
}

/** The songs of a seed's radio, ready to queue. */
export async function songRadioList(seed: RadioSeed, sources: SongRadioSources, size = RADIO_SONGS): Promise<SongRadioList> {
  const videoId = await seedVideoId(seed, sources);
  let list: SourceBrowseItem[];
  try {
    list = (await sources.browse(RADIO_LIST_SOURCE, `playlist:RDAMVM${videoId}`)).filter(isSong);
  } catch (error) {
    throw new SongRadioError(`Couldn't read YouTube Music's radio for “${seed.title}”: ${errorText(error)}`, 502);
  }
  const candidates = distinctSongs(list.filter((item) => item.id !== `t:${videoId}` && !sameSong(item, seed)));
  if (candidates.length === 0) throw new SongRadioError(`YouTube Music gave no radio for “${seed.title}”`, 502);

  if (seed.ref?.sourceId === RADIO_LIST_SOURCE) {
    return { refs: candidates.slice(0, size).map((item) => ({ sourceId: RADIO_LIST_SOURCE, trackId: item.id })), from: [RADIO_LIST_SOURCE] };
  }

  const available = new Set(await sources.available());
  const order = unique([seed.ref?.sourceId, ...PLAY_SOURCES]).filter((id) => PLAY_SOURCES.includes(id) && available.has(id));
  if (order.length === 0) {
    throw new SongRadioError("Song radio plays its songs from Spotify or Navidrome: switch one of them on in Settings", 409);
  }

  // Half again as many as needed, since some songs are on YouTube only.
  const errors: string[] = [];
  let found = 0;
  const matches = await mapLimit(candidates.slice(0, Math.ceil(size * 1.5)), SEARCH_CONCURRENCY, async (item) => {
    if (found >= size) return undefined;
    for (const sourceId of order) {
      try {
        const hit = pickMatch(await sources.search(sourceId, searchQuery(item)), item);
        if (hit) {
          found += 1;
          return { sourceId, trackId: hit.id };
        }
      } catch (error) {
        errors.push(`${SOURCE_NAMES[sourceId] ?? sourceId}: ${errorText(error)}`);
      }
    }
    return undefined;
  });
  const refs = matches.filter((ref): ref is TrackRef => !!ref).slice(0, size);
  if (refs.length === 0) {
    throw new SongRadioError(
      errors.length > 0
        ? `Couldn't look up the radio's songs (${errors[0]})`
        : `None of the radio's songs are on ${order.map((id) => SOURCE_NAMES[id] ?? id).join(" or ")}`,
      502
    );
  }
  return { refs, from: unique(refs.map((ref) => ref.sourceId)) };
}

// The YouTube Music video the radio is made from: the seed itself, or the same song found
// there by artist and title.
async function seedVideoId(seed: RadioSeed, sources: SongRadioSources): Promise<string> {
  if (seed.ref?.sourceId === RADIO_LIST_SOURCE && seed.ref.trackId.startsWith("t:")) return seed.ref.trackId.slice(2);
  let found: SourceBrowseItem[];
  try {
    found = (await sources.search(RADIO_LIST_SOURCE, searchQuery(seed))).filter(isSong);
  } catch (error) {
    throw new SongRadioError(`Couldn't look for “${seed.title}” on YouTube Music: ${errorText(error)}`, 502);
  }
  // Another version by the same artist still makes a fitting radio; another artist doesn't.
  const hit = pickMatch(found, seed)
    ?? found.find((item) => sameArtist(item.artist, seed.artist))
    ?? (seed.artist ? undefined : found[0]);
  if (!hit?.id.startsWith("t:")) throw new SongRadioError(`Couldn't find “${seed.title}” on YouTube Music to make a radio from`, 404);
  return hit.id.slice(2);
}

// --- Starting it on a room -----------------------------------------------------------

/** What the bridge's speakers do for a song radio. */
export interface SongRadioPlayer {
  nowPlaying(groupId: string): Promise<NowPlaying>;
  refFromNowPlaying(nowPlaying: NowPlaying): TrackRef | undefined;
  /** Where the room is in its queue, when the queue is what it plays. */
  queuePosition(groupId: string): Promise<{ track: number; tracks: number } | undefined>;
  /** Keeps the song playing and puts `refs` after it, in place of the rest of the queue. */
  replaceUpcoming(groupId: string, refs: TrackRef[]): Promise<NowPlaying>;
  /** Replaces the queue with `refs` and plays it. */
  play(groupId: string, refs: TrackRef[]): Promise<NowPlaying>;
  seek(groupId: string, seconds: number): Promise<unknown>;
}

/** A song from a list (search, history, …). Without a title, the song playing now. */
export interface SongRadioRequest {
  title?: string;
  artist?: string;
  sourceId?: string;
  trackId?: string;
}

export interface SongRadioResult {
  seed: { title: string; artist?: string };
  /** How many radio songs were queued. */
  songs: number;
  from: string[];
  /** The song playing now carries on, and the radio comes after it. */
  upNext: boolean;
  nowPlaying: NowPlaying;
}

export async function startSongRadio(
  groupId: string,
  request: SongRadioRequest,
  deps: { sources: SongRadioSources; player: SongRadioPlayer }
): Promise<SongRadioResult> {
  const title = request.title?.trim();
  if (title) {
    // From a list: that song, then its radio.
    const ref = request.sourceId && request.trackId ? { sourceId: request.sourceId, trackId: request.trackId } : undefined;
    const seed: RadioSeed = { title, artist: request.artist?.trim() || undefined, ref };
    const radio = await songRadioList(seed, deps.sources);
    const nowPlaying = await deps.player.play(groupId, ref ? [ref, ...radio.refs] : radio.refs);
    return { seed: { title, artist: seed.artist }, songs: radio.refs.length, from: radio.from, upNext: false, nowPlaying };
  }

  const current = await deps.player.nowPlaying(groupId);
  if (!canStartSongRadio(current)) throw new SongRadioError("Play a song first: a station, line-in or the TV has no song radio", 400);
  const ref = deps.player.refFromNowPlaying(current);
  const seed: RadioSeed = { title: current.title, artist: current.artist, ref };
  const radio = await songRadioList(seed, deps.sources);
  const result = { seed: { title: current.title, artist: current.artist }, songs: radio.refs.length, from: radio.from };

  // Playing from the queue: the song carries on, and the radio replaces what comes after it.
  if (await deps.player.queuePosition(groupId)) {
    return { ...result, upNext: true, nowPlaying: await deps.player.replaceUpcoming(groupId, radio.refs) };
  }
  // Spotify Connect, Spotify's own radio, …: the queue becomes the song and its radio, and
  // the song goes on from where it was rather than starting over.
  let nowPlaying = await deps.player.play(groupId, ref ? [ref, ...radio.refs] : radio.refs);
  const at = ref ? clockSeconds(current.position) : 0;
  if (at >= 5) {
    try {
      const moved = await deps.player.seek(groupId, at);
      if (isNowPlaying(moved)) nowPlaying = moved;
    } catch {
      // It plays from the start instead.
    }
  }
  return { ...result, upNext: false, nowPlaying };
}

// Stations, line-in and the TV report a title but no song to make a radio from.
const STREAM_URI = /^(x-sonosapi-stream|x-sonosapi-hls|x-rincon-mp3radio|aac|hls-radio|x-rincon-stream|x-sonos-htastream):/i;

/** A song with an artist and title is playing (not a station, line-in or the TV). */
export function canStartSongRadio(nowPlaying: Pick<NowPlaying, "title" | "artist" | "isLive" | "uri">): boolean {
  return !!nowPlaying.title?.trim() && !!nowPlaying.artist?.trim() && !nowPlaying.isLive && !STREAM_URI.test(nowPlaying.uri ?? "");
}

// --- Matching songs by artist and title ----------------------------------------------

/** Lower case, no accents or punctuation, and no leading "the". */
export function normalize(text = ""): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** A title without what versions add: "(Remastered 2011)", "[Official Video]", " - Live", "feat. X". */
export function cleanTitle(title: string): string {
  const cleaned = title
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+(?:feat|ft)\.?\s.*$/i, "")
    .trim();
  return cleaned || title.trim();
}

function artistNames(artist?: string): string[] {
  return (artist ?? "")
    .split(/\s*(?:,|&|\+|\/|;|\s(?:feat|ft)\.?\s|\s(?:with|and|x|vs\.?)\s)\s*/i)
    .map(normalize)
    .filter(Boolean);
}

/** Some artist both name. */
export function sameArtist(a?: string, b?: string): boolean {
  const names = artistNames(b);
  return names.length > 0 && artistNames(a).some((name) => names.includes(name));
}

export function sameTitle(a: string, b: string): boolean {
  const x = normalize(cleanTitle(a));
  return !!x && x === normalize(cleanTitle(b));
}

function sameSong(item: SourceBrowseItem, seed: RadioSeed): boolean {
  return sameTitle(item.title, seed.title) && (!seed.artist || sameArtist(item.artist, seed.artist));
}

/** The first song in `items` with the same title and artist as `wanted`. */
export function pickMatch(items: SourceBrowseItem[], wanted: { title: string; artist?: string }): SourceBrowseItem | undefined {
  return items.find((item) => isSong(item) && sameTitle(item.title, wanted.title) && sameArtist(item.artist, wanted.artist));
}

function searchQuery(song: { title: string; artist?: string }): string {
  return [artistNames(song.artist).length > 0 ? song.artist : undefined, cleanTitle(song.title)].filter(Boolean).join(" ");
}

function distinctSongs(items: SourceBrowseItem[]): SourceBrowseItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${normalize(cleanTitle(item.title))}|${artistNames(item.artist)[0] ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSong(item: SourceBrowseItem): boolean {
  return item.kind === "playable" && !item.isLive;
}

// --- Small helpers -------------------------------------------------------------------

/** Runs `task` over `items`, at most `limit` at a time, and answers in the items' order. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function unique<T>(values: (T | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

/** "0:03:21" → 201. */
function clockSeconds(clock?: string): number {
  if (!clock) return 0;
  const parts = clock.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function isNowPlaying(value: unknown): value is NowPlaying {
  return !!value && typeof value === "object" && "groupId" in value && "state" in value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
