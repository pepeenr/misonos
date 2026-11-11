import type { NowPlaying, PlayHistoryChange, PlayHistoryEntry } from "@misonos/sonos-protocol";

// The main screen's History: every song as it starts playing in a room, from any app
// (MiSonos, the Sonos app, Spotify Connect, AirPlay). It runs on the speakers' own
// events and the open apps' now-playing polls, so it records with no app open.

// A song skipped within this long after it started isn't kept: the next one replaces it.
// It also tidies a first event that came before the song's real title.
export const SKIP_MS = 10_000;
// The same song in the same room counts as the same play while it was seen playing this
// recently: a pause, a stopped radio station started again, or a regroup isn't a new play.
export const SAME_PLAY_MS = 30 * 60_000;

export interface PlayHistoryGroup {
  /** Stays the same when rooms join or leave, unlike the group id. */
  coordinatorId: string;
  /** "Living Room + Office". */
  rooms: string;
}

export interface PlayHistoryOptions {
  /** The group's coordinator and room names, if the group is known. */
  groupOf: (groupId: string) => Promise<PlayHistoryGroup | undefined>;
  /** The MiSonos source track a now-playing URI plays, if it's one of ours. */
  refOf: (uri: string | undefined) => { sourceId: string; trackId: string } | undefined;
  add: (entry: Omit<PlayHistoryEntry, "id">) => Promise<PlayHistoryEntry>;
  remove: (id: number) => Promise<void>;
  onChange: (change: PlayHistoryChange) => void;
  now?: () => number;
}

interface LastPlay {
  key: string;
  id: number;
  startedAt: number;
  seenAt: number;
  /** When the speaker was asked (NowPlaying.updatedAt): an answer read before it is old news. */
  readAt: number;
}

export class PlayHistoryRecorder {
  // Per coordinator: the song last written to the history, and when it was last seen playing.
  private readonly last = new Map<string, LastPlay>();
  // One update at a time per coordinator, so two events for one song write one row.
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: PlayHistoryOptions) {}

  /** A group's now playing, from a Sonos event or an app's poll. Never throws. */
  onNowPlaying(groupId: string, nowPlaying: NowPlaying): Promise<void> {
    if (nowPlaying.state !== "PLAYING" || !isRecordable(nowPlaying)) return Promise.resolve();
    const run = async () => {
      const group = await this.options.groupOf(groupId);
      const slot = group?.coordinatorId ?? groupId;
      const previous = this.chains.get(slot) ?? Promise.resolve();
      const next = previous.then(() => this.record(slot, groupId, group?.rooms ?? "", nowPlaying));
      this.chains.set(slot, next);
      try {
        await next;
      } finally {
        if (this.chains.get(slot) === next) this.chains.delete(slot);
      }
    };
    return run().catch((error: unknown) => {
      console.warn(`[bridge] play history: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Forget a row the user deleted, so it isn't treated as the song still playing. */
  forget(id?: number): void {
    for (const [slot, play] of this.last) {
      if (id === undefined || play.id === id) this.last.delete(slot);
    }
  }

  private async record(slot: string, groupId: string, rooms: string, nowPlaying: NowPlaying): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const key = playKey(nowPlaying);
    const readAt = Date.parse(nowPlaying.updatedAt) || now;
    const previous = this.last.get(slot);
    // A slow poll that asked before the last song was written (it races the speaker's event).
    if (previous && readAt < previous.readAt) return;
    if (previous && previous.key === key && now - previous.seenAt < SAME_PLAY_MS) {
      previous.seenAt = now;
      previous.readAt = readAt;
      return;
    }
    const ref = this.options.refOf(nowPlaying.uri);
    const entry = await this.options.add({
      playedAt: new Date(now).toISOString(),
      groupId,
      rooms,
      title: nowPlaying.title.trim(),
      artist: nowPlaying.artist?.trim() || null,
      album: nowPlaying.album?.trim() || null,
      albumArtUri: nowPlaying.albumArtUri || null,
      sourceId: ref?.sourceId ?? null,
      trackId: ref?.trackId ?? null,
      isLive: nowPlaying.isLive || isRadioUri(nowPlaying.uri)
    });
    let replacedId: number | undefined;
    if (previous && now - previous.startedAt < SKIP_MS) {
      await this.options.remove(previous.id);
      replacedId = previous.id;
    }
    this.last.set(slot, { key, id: entry.id, startedAt: now, seenAt: now, readAt });
    this.options.onChange({ entry, replacedId });
  }
}

// What a play is: a radio station keeps its URI while the song title changes, so the
// title is part of it.
function playKey(nowPlaying: NowPlaying): string {
  return [nowPlaying.uri ?? "", nowPlaying.title.trim(), nowPlaying.artist?.trim() ?? ""].join("\n");
}

// The TV and line-in aren't songs; a stream without a title has nothing to show, and
// "ZPSTR_CONNECTING" and the like are the speaker's placeholders while a stream starts.
function isRecordable(nowPlaying: NowPlaying): boolean {
  const title = nowPlaying.title?.trim();
  if (!title || title.startsWith("ZPSTR_")) return false;
  const uri = nowPlaying.uri ?? "";
  return !/^(x-sonos-htastream|x-rincon-stream):/i.test(uri);
}

function isRadioUri(uri: string | undefined): boolean {
  return !!uri && /^(x-sonosapi-stream|x-sonosapi-radio|x-rincon-mp3radio|aac|hls-radio|x-sonosapi-hls):/i.test(uri);
}
