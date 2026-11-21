import type { NowPlaying, SourceBrowseItem } from "@misonos/sonos-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  canStartSongRadio,
  cleanTitle,
  pickMatch,
  sameArtist,
  sameTitle,
  songRadioList,
  SongRadioError,
  startSongRadio,
  type SongRadioPlayer,
  type SongRadioSources,
  type TrackRef
} from "../src/songRadio.js";

const song = (id: string, title: string, artist?: string): SourceBrowseItem => ({ id, title, artist, kind: "playable" });

// YouTube Music's radio for "Karma Police": the seed first, then songs like it.
const RADIO = [
  song("t:seed", "Karma Police", "Radiohead"),
  song("t:a", "No Surprises (Remastered)", "Radiohead"),
  song("t:b", "Where Is My Mind?", "Pixies"),
  song("t:c", "YouTube-only cover", "Someone"),
  song("t:d", "Black", "Pearl Jam"),
  song("t:e", "No Surprises", "Radiohead")
];

const SPOTIFY: Record<string, SourceBrowseItem[]> = {
  "Radiohead No Surprises": [{ id: "section:songs", title: "Songs", kind: "section" }, song("spotify:track:ns", "No Surprises", "Radiohead")],
  "Pixies Where Is My Mind?": [song("spotify:track:wimm", "Where Is My Mind? - Remastered", "Pixies")],
  "Someone YouTube-only cover": [song("spotify:track:wrong", "Another Song", "Someone")],
  "Pearl Jam Black": [song("spotify:track:black", "Black", "Pearl Jam")]
};

function sources(overrides: Partial<SongRadioSources> = {}, available = ["youtube-music", "spotify", "navidrome"]) {
  const search = vi.fn(async (sourceId: string, query: string): Promise<SourceBrowseItem[]> => {
    if (sourceId === "youtube-music") return query.includes("Karma Police") ? [song("t:other", "Karma Police (Live)", "Some Band"), song("t:seed", "Karma Police", "Radiohead")] : [];
    if (sourceId === "spotify") return SPOTIFY[query] ?? [];
    return [];
  });
  const browse = vi.fn(async (_sourceId: string, id: string) => (id === "playlist:RDAMVMseed" ? RADIO : []));
  return { search, browse, available: vi.fn(async () => available), ...overrides } satisfies SongRadioSources;
}

describe("matching songs by artist and title", () => {
  it("ignores what versions add to a title", () => {
    expect(cleanTitle("No Surprises (Remastered 2009)")).toBe("No Surprises");
    expect(cleanTitle("Where Is My Mind? - Remastered")).toBe("Where Is My Mind?");
    expect(cleanTitle("Song feat. Someone")).toBe("Song");
    expect(cleanTitle("[Intro]")).toBe("[Intro]");
    expect(sameTitle("Café del Mar", "Cafe Del Mar [Official Video]")).toBe(true);
    expect(sameTitle("Karma", "Karma Police")).toBe(false);
  });

  it("matches artists that share a name, however a service lists them", () => {
    expect(sameArtist("Florence + The Machine", "Florence and the Machine")).toBe(true);
    expect(sameArtist("Calvin Harris, Dua Lipa", "Dua Lipa & Calvin Harris")).toBe(true);
    expect(sameArtist("Beyoncé", "BEYONCE")).toBe(true);
    expect(sameArtist("The Beatles", "Beatles")).toBe(true);
    expect(sameArtist("Pixies", "Radiohead")).toBe(false);
    expect(sameArtist(undefined, "Radiohead")).toBe(false);
  });

  it("picks the first song with the same title and artist", () => {
    const items = [{ id: "s", title: "Songs", kind: "section" as const }, song("1", "Black", "Sevdaliza"), song("2", "Black", "Pearl Jam")];
    expect(pickMatch(items, { title: "Black", artist: "Pearl Jam" })?.id).toBe("2");
    expect(pickMatch(items, { title: "Alive", artist: "Pearl Jam" })).toBeUndefined();
  });
});

describe("a song's radio list", () => {
  it("finds the song on YouTube Music, and plays its radio from Spotify without the seed or doubles", async () => {
    const fake = sources();
    const radio = await songRadioList({ title: "Karma Police", artist: "Radiohead" }, fake, 10);
    expect(fake.browse).toHaveBeenCalledWith("youtube-music", "playlist:RDAMVMseed");
    expect(radio.refs).toEqual([
      { sourceId: "spotify", trackId: "spotify:track:ns" },
      { sourceId: "spotify", trackId: "spotify:track:wimm" },
      { sourceId: "spotify", trackId: "spotify:track:black" }
    ]);
    expect(radio.from).toEqual(["spotify"]);
  });

  it("looks a Navidrome song's radio up in Navidrome first, then Spotify", async () => {
    const fake = sources({
      search: vi.fn(async (sourceId: string, query: string) => {
        if (sourceId === "youtube-music") return [song("t:seed", "Karma Police", "Radiohead")];
        if (sourceId === "navidrome") return query === "Pearl Jam Black" ? [song("nd-black", "Black", "Pearl Jam")] : [];
        return SPOTIFY[query] ?? [];
      })
    });
    const radio = await songRadioList({ title: "Karma Police", artist: "Radiohead", ref: { sourceId: "navidrome", trackId: "nd-kp" } }, fake, 10);
    expect(radio.refs.map((ref) => ref.trackId)).toEqual(["spotify:track:ns", "spotify:track:wimm", "nd-black"]);
    expect(radio.from).toEqual(["spotify", "navidrome"]);
  });

  it("keeps a YouTube Music song's radio on YouTube Music", async () => {
    const fake = sources();
    const radio = await songRadioList({ title: "Karma Police", artist: "Radiohead", ref: { sourceId: "youtube-music", trackId: "t:seed" } }, fake, 3);
    expect(fake.search).not.toHaveBeenCalled();
    expect(radio.refs).toEqual([
      { sourceId: "youtube-music", trackId: "t:a" },
      { sourceId: "youtube-music", trackId: "t:b" },
      { sourceId: "youtube-music", trackId: "t:c" }
    ]);
  });

  it("stops at the size it was asked for", async () => {
    const radio = await songRadioList({ title: "Karma Police", artist: "Radiohead" }, sources(), 2);
    expect(radio.refs).toHaveLength(2);
  });

  it("says so when the song isn't on YouTube Music", async () => {
    await expect(songRadioList({ title: "Unknown", artist: "Nobody" }, sources())).rejects.toThrow("Couldn't find “Unknown” on YouTube Music");
  });

  it("needs Spotify or Navidrome switched on", async () => {
    await expect(songRadioList({ title: "Karma Police", artist: "Radiohead" }, sources({}, ["youtube-music"]))).rejects.toMatchObject({ status: 409 });
  });

  it("passes on why the lookups failed", async () => {
    const fake = sources({
      search: vi.fn(async (sourceId: string) => {
        if (sourceId === "youtube-music") return [song("t:seed", "Karma Police", "Radiohead")];
        throw new Error("Sign in to Spotify first");
      })
    });
    await expect(songRadioList({ title: "Karma Police", artist: "Radiohead" }, fake, 3)).rejects.toThrow("Spotify: Sign in to Spotify first");
  });
});

describe("starting a song radio on a room", () => {
  const playing: NowPlaying = { groupId: "g1", state: "PLAYING", title: "Karma Police", artist: "Radiohead", position: "0:01:40", uri: "x-sonos-spotify:spotify%3atrack%3akp?sid=9&sn=3", updatedAt: "" };
  const KP: TrackRef = { sourceId: "spotify", trackId: "spotify:track:kp" };

  function player(overrides: Partial<SongRadioPlayer> = {}) {
    return {
      nowPlaying: vi.fn(async () => playing),
      refFromNowPlaying: vi.fn(() => KP),
      queuePosition: vi.fn(async () => undefined),
      replaceUpcoming: vi.fn(async () => playing),
      play: vi.fn(async () => playing),
      seek: vi.fn(async () => playing),
      ...overrides
    } satisfies SongRadioPlayer;
  }

  it("from a list: plays that song, then its radio", async () => {
    const speakers = player();
    const result = await startSongRadio("g1", { title: "Karma Police", artist: "Radiohead", sourceId: "navidrome", trackId: "nd-kp" }, { sources: sources(), player: speakers });
    expect(speakers.play.mock.calls[0][0]).toBe("g1");
    expect(speakers.play.mock.calls[0][1].map((ref: TrackRef) => ref.trackId)).toEqual(["nd-kp", "spotify:track:ns", "spotify:track:wimm", "spotify:track:black"]);
    expect(speakers.nowPlaying).not.toHaveBeenCalled();
    expect(result).toMatchObject({ seed: { title: "Karma Police", artist: "Radiohead" }, songs: 3, upNext: false });
  });

  it("from a history row that can't be played: just the radio", async () => {
    const speakers = player();
    await startSongRadio("g1", { title: "Karma Police", artist: "Radiohead" }, { sources: sources(), player: speakers });
    expect(speakers.play.mock.calls[0][1].map((ref: TrackRef) => ref.trackId)).toEqual(["spotify:track:ns", "spotify:track:wimm", "spotify:track:black"]);
  });

  it("from the song playing in the queue: it carries on, and the radio replaces what comes after", async () => {
    const speakers = player({ queuePosition: vi.fn(async () => ({ track: 3, tracks: 10 })) });
    const result = await startSongRadio("g1", {}, { sources: sources(), player: speakers });
    expect(speakers.replaceUpcoming).toHaveBeenCalledWith("g1", expect.arrayContaining([{ sourceId: "spotify", trackId: "spotify:track:ns" }]));
    expect(speakers.play).not.toHaveBeenCalled();
    expect(result.upNext).toBe(true);
  });

  it("from Spotify Connect: queues the song and its radio, and goes on from the same second", async () => {
    const speakers = player();
    const result = await startSongRadio("g1", {}, { sources: sources(), player: speakers });
    expect(speakers.play.mock.calls[0][1][0]).toEqual(KP);
    expect(speakers.seek).toHaveBeenCalledWith("g1", 100);
    expect(result.upNext).toBe(false);
  });

  it("refuses a station", async () => {
    const speakers = player({ nowPlaying: vi.fn(async () => ({ ...playing, uri: "x-sonosapi-stream:s123?sid=254", isLive: true })) });
    await expect(startSongRadio("g1", {}, { sources: sources(), player: speakers })).rejects.toBeInstanceOf(SongRadioError);
    expect(speakers.play).not.toHaveBeenCalled();
  });

  it("knows what a song radio can start from", () => {
    expect(canStartSongRadio(playing)).toBe(true);
    expect(canStartSongRadio({ ...playing, artist: undefined })).toBe(false);
    expect(canStartSongRadio({ ...playing, uri: "x-rincon-mp3radio://stream.example/live" })).toBe(false);
    expect(canStartSongRadio({ ...playing, uri: "x-rincon-stream:RINCON_A01400" })).toBe(false);
    expect(canStartSongRadio({ ...playing, uri: "x-sonosapi-radio:spotify%3aartistRadio%3aART?sid=9&sn=3" })).toBe(true);
  });
});
