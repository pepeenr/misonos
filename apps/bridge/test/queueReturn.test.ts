import type { NowPlaying } from "@misonos/sonos-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueReturn, type TrackRef } from "../src/queueReturn.js";

const SONG: TrackRef = { sourceId: "navidrome", trackId: "song" };
const OTHER: TrackRef = { sourceId: "navidrome", trackId: "other" };
const QUEUE: TrackRef[] = [{ sourceId: "navidrome", trackId: "a" }, { sourceId: "navidrome", trackId: "b" }, { sourceId: "navidrome", trackId: "c" }];

// Now-playing URIs are just "sourceId/trackId" here.
const uriOf = (ref: TrackRef) => `${ref.sourceId}/${ref.trackId}`;
const refOf = (uri: string | undefined): TrackRef | undefined => {
  const [sourceId, trackId] = uri?.split("/") ?? [];
  return sourceId && trackId ? { sourceId, trackId } : undefined;
};

function nowPlaying(state: NowPlaying["state"], ref: TrackRef = SONG, position = "0:00:00", duration = "0:03:00"): NowPlaying {
  return { groupId: "g1", state, title: ref.trackId, uri: uriOf(ref), position, duration, updatedAt: new Date().toISOString() };
}

describe("returning to the queue after a single song", () => {
  let resume: ReturnType<typeof vi.fn>;
  let queueReturn: QueueReturn;

  beforeEach(() => {
    vi.useFakeTimers();
    resume = vi.fn(async () => {});
    queueReturn = new QueueReturn({ refOf, resume, delayMs: 3000 });
    queueReturn.onEnqueue("g1", { mode: "replace", singleTrack: SONG, replaced: { items: QUEUE, startTrack: 2 } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Play the song from the start, then let it run to its end.
  function playToEnd(): void {
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING"));
    vi.advanceTimersByTime(180_000);
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED"));
  }

  it("puts the replaced queue back 3 s after the song ends, from the track it was on", () => {
    playToEnd();
    vi.advanceTimersByTime(2999);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledWith("g1", QUEUE, 2);
    // Only once, however many events follow.
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED"));
    vi.advanceTimersByTime(10_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("leaves a pause, and a stop well before the song's end, alone", () => {
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING"));
    vi.advanceTimersByTime(60_000);
    queueReturn.onNowPlaying("g1", nowPlaying("PAUSED_PLAYBACK", SONG, "0:01:00"));
    vi.advanceTimersByTime(10_000);
    // A sleep timer or the stop button, two minutes before the end.
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED"));
    vi.advanceTimersByTime(10_000);
    expect(resume).not.toHaveBeenCalled();
    // Played again later, from a minute in, and this time to its end.
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING", SONG, "0:01:00"));
    vi.advanceTimersByTime(120_000);
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED"));
    vi.advanceTimersByTime(3000);
    expect(resume).toHaveBeenCalledWith("g1", QUEUE, 2);
  });

  it("does nothing when play is pressed again within the 3 s", () => {
    playToEnd();
    vi.advanceTimersByTime(1500);
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING"));
    vi.advanceTimersByTime(10_000);
    expect(resume).not.toHaveBeenCalled();
  });

  it("gives up once something else plays or the queue changes", () => {
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING"));
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING", OTHER));
    vi.advanceTimersByTime(180_000);
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED"));
    vi.advanceTimersByTime(10_000);
    expect(resume).not.toHaveBeenCalled();

    queueReturn.onEnqueue("g1", { mode: "replace", singleTrack: SONG, replaced: { items: QUEUE, startTrack: 1 } });
    queueReturn.onEnqueue("g1", { mode: "next" });
    playToEnd();
    vi.advanceTimersByTime(10_000);
    expect(resume).not.toHaveBeenCalled();
  });

  it("returns to the queue from before a run of single songs", () => {
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING"));
    // A second song over the first: its "replaced" queue is just the first song.
    queueReturn.onEnqueue("g1", { mode: "replace", singleTrack: OTHER });
    queueReturn.onNowPlaying("g1", nowPlaying("PLAYING", OTHER));
    vi.advanceTimersByTime(180_000);
    queueReturn.onNowPlaying("g1", nowPlaying("STOPPED", OTHER));
    vi.advanceTimersByTime(3000);
    expect(resume).toHaveBeenCalledWith("g1", QUEUE, 2);
  });

  it("ignores a replace that queued more than one track", () => {
    queueReturn.onEnqueue("g1", { mode: "replace", replaced: { items: QUEUE, startTrack: 1 } });
    playToEnd();
    vi.advanceTimersByTime(10_000);
    expect(resume).not.toHaveBeenCalled();
  });
});
