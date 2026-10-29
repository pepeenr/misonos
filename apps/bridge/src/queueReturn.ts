import type { NowPlaying, PlaybackMode } from "@misonos/sonos-protocol";

export interface TrackRef {
  sourceId: string;
  trackId: string;
}

// "Play now" on a single song replaces the whole queue with it, so once the song ends
// the speakers fall silent. This brings back the queue the song replaced: when the song
// has played to its end, wait a moment, then put the old queue back from the track it
// was on, and play. It runs on the speakers' own events, so it works with no app open.

// How long the speakers stay quiet after the song before the old queue comes back.
export const RETURN_DELAY_MS = 3000;
// A stop this long before the song's expected end is a stop or a sleep timer, not the
// song finishing, so it stays stopped.
const END_SLACK_MS = 15_000;

interface Detour {
  song: TrackRef;
  queue: TrackRef[];
  startTrack: number;
  heardPlaying: boolean;
  endsAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface QueueReturnOptions {
  /** The source track a now-playing URI plays, if it's one of ours. */
  refOf: (uri: string | undefined) => TrackRef | undefined;
  /** Put `queue` back on the group from `startTrack`, and play. */
  resume: (groupId: string, queue: TrackRef[], startTrack: number) => Promise<void>;
  delayMs?: number;
  now?: () => number;
}

export class QueueReturn {
  private readonly detours = new Map<string, Detour>();

  constructor(private readonly options: QueueReturnOptions) {}

  /** A MiSonos play changed the group's queue. */
  onEnqueue(groupId: string, event: { mode: PlaybackMode; singleTrack?: TrackRef; replaced?: { items: TrackRef[]; startTrack: number } }): void {
    const previous = this.detours.get(groupId);
    this.cancel(groupId);
    if (event.mode !== "replace" || !event.singleTrack) return;
    // A song played over another single song still returns to the queue before both.
    const queue = event.replaced ?? (previous ? { items: previous.queue, startTrack: previous.startTrack } : undefined);
    if (!queue || queue.items.length === 0) return;
    this.detours.set(groupId, { song: event.singleTrack, queue: queue.items, startTrack: queue.startTrack, heardPlaying: false });
  }

  /** The group's transport changed (a Sonos event). */
  onNowPlaying(groupId: string, nowPlaying: NowPlaying): void {
    const detour = this.detours.get(groupId);
    if (!detour) return;
    const now = this.options.now?.() ?? Date.now();
    if (nowPlaying.uri && !sameTrack(this.options.refOf(nowPlaying.uri), detour.song)) {
      // Something else is on now (picked in another app, or more tracks were queued).
      this.cancel(groupId);
      return;
    }
    if (nowPlaying.state === "PLAYING") {
      detour.heardPlaying = true;
      this.clearTimer(detour);
      const duration = seconds(nowPlaying.duration);
      detour.endsAt = duration ? now + (duration - (seconds(nowPlaying.position) ?? 0)) * 1000 : undefined;
      return;
    }
    if (nowPlaying.state === "PAUSED_PLAYBACK") {
      this.clearTimer(detour);
      return;
    }
    if (nowPlaying.state !== "STOPPED" || !detour.heardPlaying || detour.timer) return;
    if (detour.endsAt !== undefined && now < detour.endsAt - END_SLACK_MS) return;
    detour.timer = setTimeout(() => {
      this.detours.delete(groupId);
      this.options.resume(groupId, detour.queue, detour.startTrack).catch((error: unknown) => {
        console.warn(`[bridge] returning to the previous queue failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.options.delayMs ?? RETURN_DELAY_MS);
  }

  cancel(groupId: string): void {
    const detour = this.detours.get(groupId);
    if (!detour) return;
    this.clearTimer(detour);
    this.detours.delete(groupId);
  }

  private clearTimer(detour: Detour): void {
    if (detour.timer) clearTimeout(detour.timer);
    detour.timer = undefined;
  }
}

function sameTrack(a: TrackRef | undefined, b: TrackRef): boolean {
  return !!a && a.sourceId === b.sourceId && a.trackId === b.trackId;
}

/** "0:04:04" (or "4:04") → 244. */
function seconds(time: string | undefined): number | undefined {
  if (!time || !/^\d+(:\d{1,2}){1,2}$/.test(time)) return undefined;
  const value = time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return value > 0 ? value : undefined;
}
