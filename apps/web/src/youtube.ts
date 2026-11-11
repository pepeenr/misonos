import type { YouTubeImportJob } from "@misonos/sonos-protocol";

// A YouTube link pasted into the search box is got from YouTube instead of searched
// for: Downtify downloads it into Navidrome and the bridge plays it (youtubeImport.ts).

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/i;

export function isYouTubeLink(text: string): boolean {
  if (!/^https?:\/\//i.test(text.trim())) return false;
  try {
    return YOUTUBE_HOSTS.test(new URL(text.trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * What a link brings, as the bridge reads it (youtubeImport.ts youtubeLink): a video
 * opened from a playlist means the playlist, and a Mix (list=RD…) the song and what
 * YouTube Music's radio plays after it.
 */
export function youtubeLinkKind(text: string): "video" | "playlist" | "mix" {
  const list = new URL(text.trim()).searchParams.get("list");
  if (!list) return "video";
  return list.startsWith("RD") && !list.startsWith("RDCLAK5uy_") ? "mix" : "playlist";
}

/**
 * The video a link points at, as the bridge reads it (youtubeImport.ts videoIdOf):
 * watch?v=, youtu.be/, /shorts/, /live/, or the song a Mix was started from. A plain
 * playlist has none, so it can be downloaded but not played.
 */
export function linkVideoId(text: string): string | undefined {
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
    list.startsWith("RD") && !list.startsWith("RDCLAK5uy_") ? list.slice(2) : undefined
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate)));
}

// Characters that print as nothing (Hangul fillers, the blank Braille cell, zero-width
// spaces): uploads use them for "blank" names, which then show as a wide gap.
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u2800\u200B-\u200D\u2060\uFEFF]/gu;

/** A YouTube name as it can be shown: without the characters that print as nothing. */
export function visibleName(name: string | undefined): string | undefined {
  const shown = name?.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return shown || undefined;
}

/** What Enter will do with a pasted link. */
export function describeLink(text: string, options: { play: boolean; playlist: string; mixSongs: number }): string {
  const kind = youtubeLinkKind(text);
  const what = kind === "mix" ? `the song and the next ${options.mixSongs} from its Mix` : kind === "playlist" ? "the playlist" : "it";
  if (!options.play) return `Enter gets ${what} from YouTube into the ${options.playlist} playlist.`;
  return kind === "mix" ? `Enter gets ${what}, and plays them.` : `Enter gets ${what} from YouTube and plays it.`;
}

/** One line on how an import is going, for under the search box. */
export function describeImport(job: YouTubeImportJob, playlist: string): string {
  const total = job.tracks.length;
  if (job.status === "resolving") return "Looking up the YouTube link…";
  const note = job.note ? ` ${job.note}` : "";
  if (job.status === "failed") return `Couldn't get it from YouTube: ${job.error ?? "something went wrong"}`;
  if (job.status === "running") {
    const current = job.tracks.find((track) => track.status === "downloading" || track.status === "finding");
    if (!current) return "Getting the songs from YouTube…";
    const position = total > 1 ? ` (${job.tracks.indexOf(current) + 1} of ${total})` : "";
    return current.status === "downloading"
      ? `Downloading “${current.title}”${position}…`
      : `Adding “${current.title}” to Navidrome${position}…`;
  }
  const got = job.tracks.filter((track) => track.status !== "failed");
  const failed = job.tracks.filter((track) => track.status === "failed");
  const first = got[0];
  let line = "";
  if (!first) line = "Nothing came through.";
  else if (first.status === "saved") line = got.length === 1 ? `Saved “${first.title}” to the ${playlist} playlist.` : `Saved ${got.length} songs to the ${playlist} playlist.`;
  else if (first.status === "playing") line = got.length === 1 ? `Playing “${first.title}”.` : `Playing “${first.title}”, with ${got.length - 1} more queued.`;
  else line = got.length === 1 ? `Queued “${first.title}”.` : `Queued ${got.length} songs.`;
  if (failed.length === 1) line += ` “${failed[0].title}” failed: ${failed[0].error ?? "unknown error"}`;
  else if (failed.length > 1) line += ` ${failed.length} songs failed.`;
  return line + note;
}
