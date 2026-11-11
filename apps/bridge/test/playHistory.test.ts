import type { NowPlaying, PlayHistoryChange, PlayHistoryEntry } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { PlayHistoryRecorder, SAME_PLAY_MS, SKIP_MS, type PlayHistoryGroup } from "../src/playHistory.js";

// Navidrome tracks are "navidrome/<id>" here; anything else isn't a MiSonos source.
const refOf = (uri: string | undefined) => {
  const match = uri?.match(/^navidrome\/(.+)$/);
  return match ? { sourceId: "navidrome", trackId: match[1] } : undefined;
};

describe("the play history", () => {
  let clock: number;
  let rows: PlayHistoryEntry[];
  let changes: PlayHistoryChange[];
  let groups: Record<string, PlayHistoryGroup>;
  let recorder: PlayHistoryRecorder;

  beforeEach(() => {
    clock = Date.parse("2026-11-11T18:00:00Z");
    rows = [];
    changes = [];
    groups = {
      g1: { coordinatorId: "living", rooms: "Living Room" },
      g2: { coordinatorId: "office", rooms: "Office" },
      // Office joined Living Room: a new group id, the same coordinator.
      g3: { coordinatorId: "living", rooms: "Living Room + Office" }
    };
    let nextId = 1;
    recorder = new PlayHistoryRecorder({
      groupOf: async (groupId) => groups[groupId],
      refOf,
      add: async (entry) => {
        const row = { ...entry, id: nextId++ };
        rows.unshift(row);
        return row;
      },
      remove: async (id) => { rows = rows.filter((row) => row.id !== id); },
      onChange: (change) => changes.push(change),
      now: () => clock
    });
  });

  function playing(groupId: string, title: string, extra: Partial<NowPlaying> = {}): NowPlaying {
    return { groupId, state: "PLAYING", title, artist: "Artist", uri: `navidrome/${title}`, updatedAt: new Date(clock).toISOString(), ...extra };
  }

  async function at(minutes: number, nowPlaying: NowPlaying): Promise<void> {
    clock += minutes * 60_000;
    await recorder.onNowPlaying(nowPlaying.groupId, { ...nowPlaying, updatedAt: new Date(clock).toISOString() });
  }

  it("writes each song once, as it starts, with the room and its source track", async () => {
    await at(0, playing("g1", "One"));
    await at(0.1, playing("g1", "One", { position: "0:00:06" }));
    await at(3, playing("g1", "Two"));
    expect(rows.map((row) => row.title)).toEqual(["Two", "One"]);
    expect(rows[1]).toMatchObject({ rooms: "Living Room", groupId: "g1", sourceId: "navidrome", trackId: "One", artist: "Artist", isLive: false });
    expect(changes.map((change) => change.entry.title)).toEqual(["One", "Two"]);
  });

  it("drops a song skipped within seconds, telling the apps which row went", async () => {
    await at(0, playing("g1", "One"));
    await at(4, playing("g1", "Two"));
    clock += SKIP_MS - 1000;
    await recorder.onNowPlaying("g1", playing("g1", "Three"));
    expect(rows.map((row) => row.title)).toEqual(["Three", "One"]);
    expect(changes.at(-1)).toMatchObject({ entry: { title: "Three" }, replacedId: 2 });
  });

  it("doesn't count a pause, or Office joining the room, as a new play", async () => {
    await at(0, playing("g1", "One"));
    await at(1, { ...playing("g1", "One"), state: "PAUSED_PLAYBACK" });
    await at(5, playing("g1", "One"));
    await at(1, playing("g3", "One"));
    expect(rows).toHaveLength(1);
  });

  it("lists a song again when it comes back later", async () => {
    await at(0, playing("g1", "One"));
    await at(SAME_PLAY_MS / 60_000 + 1, playing("g1", "One"));
    expect(rows.map((row) => row.title)).toEqual(["One", "One"]);
  });

  it("keeps each room's songs apart", async () => {
    await at(0, playing("g1", "One"));
    await at(0.05, playing("g2", "One"));
    expect(rows.map((row) => row.rooms)).toEqual(["Office", "Living Room"]);
    expect(changes.every((change) => change.replacedId === undefined)).toBe(true);
  });

  it("logs every song a radio station plays, and marks it live", async () => {
    const radio = (title: string) => playing("g1", title, { uri: "x-rincon-mp3radio://radio.example/stream", artist: undefined });
    await at(0, radio("Song A"));
    await at(4, radio("Song B"));
    expect(rows.map((row) => row.title)).toEqual(["Song B", "Song A"]);
    expect(rows[0]).toMatchObject({ isLive: true, sourceId: null, trackId: null });
  });

  it("leaves out stops, the TV, line-in, untitled streams and the speaker's placeholders", async () => {
    await at(0, { ...playing("g1", "One"), state: "STOPPED" });
    await at(1, playing("g1", "TV", { uri: "x-sonos-htastream:RINCON_1:spdif" }));
    await at(1, playing("g1", "Line-In", { uri: "x-rincon-stream:RINCON_1" }));
    await at(1, playing("g1", "  "));
    await at(1, playing("g1", "ZPSTR_CONNECTING"));
    expect(rows).toEqual([]);
  });

  it("ignores a slow poll that asked before the newer song was written", async () => {
    const asked = new Date(clock).toISOString();
    await at(3, playing("g1", "Two"));
    // A poll sent before "Two" started answers only now, with the song before it.
    await recorder.onNowPlaying("g1", { ...playing("g1", "One"), updatedAt: asked });
    expect(rows.map((row) => row.title)).toEqual(["Two"]);
  });

  it("writes one row when an event and a poll report the same new song at once", async () => {
    clock += 60_000;
    await Promise.all([recorder.onNowPlaying("g1", playing("g1", "One")), recorder.onNowPlaying("g1", playing("g1", "One"))]);
    expect(rows).toHaveLength(1);
  });

  it("starts over for a row the user deleted", async () => {
    await at(0, playing("g1", "One"));
    rows = [];
    recorder.forget(1);
    await at(1, playing("g1", "One"));
    expect(rows.map((row) => row.title)).toEqual(["One"]);
  });

  it("never throws when the store fails", async () => {
    recorder = new PlayHistoryRecorder({
      groupOf: async () => undefined,
      refOf,
      add: async () => { throw new Error("disk full"); },
      remove: async () => {},
      onChange: () => {},
      now: () => clock
    });
    await expect(recorder.onNowPlaying("g1", playing("g1", "One"))).resolves.toBeUndefined();
  });
});
