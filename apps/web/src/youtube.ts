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

/** One line on how an import is going, for under the search box. */
export function describeImport(job: YouTubeImportJob, playlist: string): string {
  const total = job.tracks.length;
  if (job.status === "resolving") return "Looking up the YouTube link…";
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
  return line;
}
