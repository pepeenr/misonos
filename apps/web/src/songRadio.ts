import type { NowPlaying } from "@misonos/sonos-protocol";

/** What the bridge answers when a song radio starts (apps/bridge/src/songRadio.ts). */
export interface SongRadioResult {
  seed: { title: string; artist?: string };
  songs: number;
  from: string[];
  /** The song playing now carries on, and the radio comes after it. */
  upNext: boolean;
  nowPlaying: NowPlaying;
}

/** The song a radio starts from, when it isn't the one playing now. */
export interface SongRadioSeed {
  title: string;
  artist?: string;
  sourceId?: string;
  trackId?: string;
}

// Stations, line-in and the TV report a title but no song to make a radio from. The
// bridge checks the same (canStartSongRadio in songRadio.ts).
const STREAM_URI = /^(x-sonosapi-stream|x-sonosapi-hls|x-rincon-mp3radio|aac|hls-radio|x-rincon-stream|x-sonos-htastream):/i;

/** A song with an artist and title is playing, so a song radio can start from it. */
export function canStartSongRadio(nowPlaying: Pick<NowPlaying, "title" | "artist" | "isLive" | "uri"> | null | undefined): boolean {
  if (!nowPlaying) return false;
  return !!nowPlaying.title?.trim() && !!nowPlaying.artist?.trim() && !nowPlaying.isLive && !STREAM_URI.test(nowPlaying.uri ?? "");
}

const SOURCE_NAMES: Record<string, string> = { spotify: "Spotify", navidrome: "Navidrome", "youtube-music": "YouTube Music" };

/** "Radio from “Karma Police”: 25 songs from Spotify." */
export function songRadioMessage(result: Pick<SongRadioResult, "seed" | "songs" | "from" | "upNext">): string {
  const from = result.from.map((id) => SOURCE_NAMES[id] ?? id).join(" and ");
  const songs = `${result.songs} ${result.songs === 1 ? "song" : "songs"}${from ? ` from ${from}` : ""}`;
  return result.upNext
    ? `Radio from “${result.seed.title}” comes after this song: ${songs}.`
    : `Radio from “${result.seed.title}”: ${songs}.`;
}
