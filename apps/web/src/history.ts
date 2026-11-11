import type { PlayHistoryChange, PlayHistoryEntry } from "@misonos/sonos-protocol";

// The History card's days and live updates.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", "Monday" within the week, then "Mon 3 Nov" (with the year once it's another year). */
export function dayLabel(playedAt: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(playedAt)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[playedAt.getDay()];
  const label = `${WEEKDAYS[playedAt.getDay()].slice(0, 3)} ${playedAt.getDate()} ${MONTHS[playedAt.getMonth()]}`;
  return playedAt.getFullYear() === now.getFullYear() ? label : `${label} ${playedAt.getFullYear()}`;
}

/** The entries in days, newest first, as they come from the bridge. */
export function byDay(entries: PlayHistoryEntry[], now: Date = new Date()): { label: string; entries: PlayHistoryEntry[] }[] {
  const days: { label: string; entries: PlayHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const label = dayLabel(new Date(entry.playedAt), now);
    const last = days.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }
  return days;
}

/** A live change applied to the list: the new song on top, a skipped one taken out. */
export function applyChange(entries: PlayHistoryEntry[], change: PlayHistoryChange): PlayHistoryEntry[] {
  return [change.entry, ...entries.filter((entry) => entry.id !== change.entry.id && entry.id !== change.replacedId)];
}
