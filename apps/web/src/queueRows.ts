import type { QueueItem } from "@misonos/sonos-protocol";

const ROW_FIELDS = ["id", "uri", "title", "artist", "album", "albumArtUri", "sourceId", "trackId"] as const;

/** Two listings of a queue that show the same rows (open apps poll it every few seconds). */
export function sameQueue(a: QueueItem[], b: QueueItem[]): boolean {
  return a.length === b.length && a.every((item, index) => ROW_FIELDS.every((field) => item[field] === b[index][field]));
}
