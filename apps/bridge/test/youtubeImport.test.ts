import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying, PlaybackMode, SourceBrowseItem, YouTubeImportJob, YouTubeSongNames } from "@misonos/sonos-protocol";
import type { DowntifySong } from "../src/downtify.js";
import { FALLBACK_ARTIST, isYouTubeLink, MIX_SONGS, namesToSave, pickTrack, videoIdOf, youtubeLink, YouTubeImporter, YouTubeImportError, type DowntifyApi } from "../src/youtubeImport.js";

// A YouTube upload named with Hangul fillers ("ㅤ", three bytes each): too long for a file.
const PADDED = { song_id: "8h4xp8OREjs", name: "ㅤ".repeat(100), artists: ["ㅤ".repeat(46) + "ꞋꞌꞋꞌ"], duration: 3540 };

const ENDPOINT = { url: "http://127.0.0.1", host: "downtify.example" };

function track(id: string, title: string, durationSeconds?: number, artist?: string): SourceBrowseItem {
  return { id, title, kind: "playable", durationSeconds, artist };
}

describe("isYouTubeLink", () => {
  it("knows YouTube's addresses", () => {
    expect(isYouTubeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeLink(" https://youtu.be/dQw4w9WgXcQ ")).toBe(true);
    expect(isYouTubeLink("https://music.youtube.com/playlist?list=PL123")).toBe(true);
    expect(isYouTubeLink("https://m.youtube.com/shorts/abc")).toBe(true);
    expect(isYouTubeLink("https://notyoutube.com/watch?v=1")).toBe(false);
    expect(isYouTubeLink("never gonna give you up")).toBe(false);
  });
});

describe("youtubeLink", () => {
  it("takes a video in a playlist as the playlist, and a Mix as its song", () => {
    expect(youtubeLink("https://youtu.be/aaaaaaaaaaa")).toEqual({ kind: "video", resolve: "https://youtu.be/aaaaaaaaaaa" });
    expect(youtubeLink("https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLxyz&index=3")).toEqual({ kind: "playlist", resolve: "https://www.youtube.com/playlist?list=PLxyz" });
    expect(youtubeLink("https://www.youtube.com/watch?v=_ltWsgnR9Gw&list=RD_ltWsgnR9Gw&start_radio=1")).toEqual({ kind: "mix", resolve: "https://www.youtube.com/watch?v=_ltWsgnR9Gw" });
    expect(youtubeLink("https://www.youtube.com/playlist?list=RD_ltWsgnR9Gw").kind).toBe("mix");
    // YouTube Music's curated playlists start with RD too, but aren't radio.
    expect(youtubeLink("https://music.youtube.com/playlist?list=RDCLAK5uy_abc").kind).toBe("playlist");
  });
});

describe("videoIdOf", () => {
  it("finds the video in each kind of link, and none in a plain playlist", () => {
    expect(videoIdOf("https://www.youtube.com/watch?v=8h4xp8OREjs")).toBe("8h4xp8OREjs");
    expect(videoIdOf("https://youtu.be/8h4xp8OREjs?si=abc")).toBe("8h4xp8OREjs");
    expect(videoIdOf("https://www.youtube.com/shorts/8h4xp8OREjs")).toBe("8h4xp8OREjs");
    expect(videoIdOf("https://music.youtube.com/watch?v=8h4xp8OREjs&list=PLxyz")).toBe("8h4xp8OREjs");
    expect(videoIdOf("https://www.youtube.com/playlist?list=RD8h4xp8OREjs")).toBe("8h4xp8OREjs");
    expect(videoIdOf("https://www.youtube.com/playlist?list=PLxyz")).toBeUndefined();
    expect(videoIdOf("https://www.youtube.com/watch?v=short")).toBeUndefined();
  });
});

describe("namesToSave", () => {
  it("keeps YouTube's names when they fit, and takes the ones asked for", () => {
    const song = { song_id: "aaaaaaaaaaa", name: "Ripple", artists: ["Grateful Dead"] };
    expect(namesToSave(song)).toEqual({ names: {}, shortened: false });
    expect(namesToSave(song, { artist: " jazzhousestudio ", title: "" })).toEqual({ names: { artist: "jazzhousestudio" }, shortened: false });
  });

  it("saves a song whose names are too long for a file under its video id", () => {
    // The channel (150 bytes) fits as a folder and next to the id: only the title goes.
    expect(namesToSave(PADDED)).toEqual({ names: { title: "8h4xp8OREjs" }, shortened: true });
    const longChannel = { ...PADDED, artists: ["ㅤ".repeat(90)] };
    expect(namesToSave(longChannel)).toEqual({ names: { artist: FALLBACK_ARTIST, title: "8h4xp8OREjs" }, shortened: true });
    // The artist folder alone fits (150 bytes): only the file name was too long.
    expect(namesToSave({ ...PADDED, name: "Tired" }).shortened).toBe(false);
    expect(namesToSave(PADDED, { artist: "jazzhousestudio" })).toEqual({ names: { artist: "jazzhousestudio", title: "8h4xp8OREjs" }, shortened: true });
    expect(namesToSave(PADDED, { artist: "jazzhousestudio", title: "Tired" })).toEqual({ names: { artist: "jazzhousestudio", title: "Tired" }, shortened: false });
  });

  it("replaces names that print as nothing, however short", () => {
    const blank = { song_id: "8h4xp8OREjs", name: "ㅤㅤ​", artists: ["ㅤ ⠀"] };
    expect(namesToSave(blank)).toEqual({ names: { artist: FALLBACK_ARTIST, title: "8h4xp8OREjs" }, shortened: true });
    expect(namesToSave({ ...blank, name: "Tired" }).names).toEqual({ artist: FALLBACK_ARTIST });
  });
});

describe("pickTrack", () => {
  const song: DowntifySong = { name: "Ripple (Live)", artists: ["Grateful Dead"], duration: 250 };

  it("matches the title whatever its case and punctuation, and the length", () => {
    expect(pickTrack([track("a", "ripple - live", 251)], song)?.id).toBe("a");
    expect(pickTrack([track("a", "Ripple (Live)", 300)], song)).toBeUndefined();
    expect(pickTrack([{ id: "x", title: "Ripple (Live)", kind: "container" }], song)).toBeUndefined();
  });

  it("lets the artist pick between songs of the same name", () => {
    const items = [track("cover", "Ripple (Live)", 250, "Someone Else"), track("dead", "Ripple (Live)", 249, "Grateful Dead")];
    expect(pickTrack(items, song)?.id).toBe("dead");
  });
});

describe("YouTubeImporter", () => {
  let dir: string;
  let pairingPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "misonos-yt-"));
    pairingPath = path.join(dir, "downtify.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Navidrome "has" a song once Downtify has downloaded it, after `lag` searches.
  function setup(songs: DowntifySong[], options: { failDownload?: string; lag?: number; ownTitles?: Record<string, string>; mix?: DowntifySong[] | Error; playlistFails?: boolean; resolveFails?: boolean } = {}) {
    // Navidrome lists a song under the title it was saved with.
    const downloaded = new Map<string, DowntifySong>();
    const searches = new Map<string, number>();
    const downloads: Array<{ song: DowntifySong; names?: YouTubeSongNames }> = [];
    const added: string[] = [];
    const plays: Array<{ trackIds: string[]; groupId: string; mode: PlaybackMode }> = [];
    const videoPlays: Array<{ videoId: string; groupId: string; mode: PlaybackMode }> = [];
    const events: YouTubeImportJob[] = [];
    const resolved: string[] = [];
    const similar: unknown[][] = [];
    let tokenUsed: string | undefined;
    let finished: (job: YouTubeImportJob) => void = () => undefined;
    const done = new Promise<YouTubeImportJob>((resolve) => { finished = resolve; });
    const client: DowntifyApi = {
      pair: async (code) => {
        if (code !== "123456") throw Object.assign(new Error("Wrong or expired pairing code"), { status: 401 });
        return { token: "dtfy_1_secret", user: { username: "pepe" } };
      },
      resolve: async (link) => {
        resolved.push(link);
        if (options.resolveFails) throw new Error("Downtify answered 502");
        const id = new URL(link).searchParams.get("v");
        if (id) {
          const song = songs.find((entry) => entry.song_id === id);
          return song ? [{ ...song, name: options.ownTitles?.[id] ?? song.name }] : [];
        }
        return songs;
      },
      similar: async (...args) => {
        similar.push(args);
        if (options.mix instanceof Error) throw options.mix;
        return options.mix ?? [];
      },
      download: async (song, names) => {
        downloads.push(names ? { song, names } : { song });
        if (song.song_id === options.failDownload) throw new Error("Video unavailable");
        downloaded.set(names?.title ?? song.name ?? "", song);
        return `YouTube/${names?.title ?? song.name}.opus`;
      }
    };
    const importer = new YouTubeImporter({
      endpoint: ENDPOINT,
      playlist: "YouTube",
      pairingPath,
      search: async (query) => {
        const count = (searches.get(query) ?? 0) + 1;
        searches.set(query, count);
        const song = downloaded.get(query);
        if (!song || count <= (options.lag ?? 0)) return [];
        return [{ id: "section:songs", title: "Songs", kind: "section" }, track(`nd:${song.song_id}`, query, song.duration)];
      },
      play: async (trackIds, groupId, mode) => {
        plays.push({ trackIds, groupId, mode });
        return { groupId, state: "PLAYING", updatedAt: new Date().toISOString() } as NowPlaying;
      },
      playVideo: async (videoId, groupId, mode) => {
        videoPlays.push({ videoId, groupId, mode });
        return { groupId, state: "PLAYING", updatedAt: new Date().toISOString() } as NowPlaying;
      },
      addToPlaylist: async (trackIds) => {
        if (options.playlistFails) throw new Error("Navidrome: HTTP 500");
        added.push(...trackIds);
      },
      onChange: (job) => {
        events.push(structuredClone(job));
        if (job.finishedAt) finished(structuredClone(job));
      },
      client: (_endpoint, token) => {
        tokenUsed = token;
        return client;
      },
      findPollMs: 1,
      findTimeoutMs: 200
    });
    return { importer, downloads, added, plays, videoPlays, events, done, resolved, similar, tokenUsed: () => tokenUsed };
  }

  it("pairs with a Downtify code and keeps the token", async () => {
    const { importer } = setup([]);
    expect(await importer.status()).toEqual({ available: true, paired: false, username: undefined, playlist: "YouTube", mixSongs: MIX_SONGS });
    await expect(importer.start({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" })).rejects.toMatchObject({ status: 409 });

    expect(await importer.pair(" 123 456 ")).toMatchObject({ paired: true, username: "pepe" });
    expect(JSON.parse(await readFile(pairingPath, "utf8"))).toMatchObject({ token: "dtfy_1_secret", username: "pepe" });
    await expect(importer.pair("999999")).rejects.toBeInstanceOf(YouTubeImportError);

    expect(await importer.unpair()).toMatchObject({ paired: false });
  });

  it("downloads a video into the playlist, waits for Navidrome, and plays it", async () => {
    const song = { song_id: "aaaaaaaaaaa", name: "Ripple", artists: ["Grateful Dead"], duration: 250, url: "https://music.youtube.com/watch?v=aaaaaaaaaaa" };
    const { importer, downloads, added, plays, done, tokenUsed } = setup([song], { lag: 2 });
    await importer.pair("123456");

    const started = await importer.start({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", groupId: "g1" });
    expect(started.status).toBe("resolving");
    const job = await done;

    expect(tokenUsed()).toBe("dtfy_1_secret");
    expect(downloads).toEqual([{ song }]);
    expect(added).toEqual(["nd:aaaaaaaaaaa"]);
    expect(plays).toEqual([{ trackIds: ["nd:aaaaaaaaaaa"], groupId: "g1", mode: "replace" }]);
    expect(job).toMatchObject({ status: "done", tracks: [{ title: "Ripple", artist: "Grateful Dead", status: "playing" }] });
    expect(importer.recent()[0].id).toBe(started.id);
  });

  it("plays a playlist's first song and queues the rest, past a failed one", async () => {
    const songs = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((id, index) => ({ song_id: id, name: `Song ${index + 1}`, duration: 200 + index }));
    const { importer, downloads, plays, done } = setup(songs, {
      failDownload: "bbbbbbbbbbb",
      ownTitles: { ccccccccccc: "Song 3 (Official Audio)" }
    });
    await importer.pair("123456");

    await importer.start({ url: "https://www.youtube.com/playlist?list=PL123", groupId: "g1" });
    const job = await done;

    expect(downloads.map((entry) => entry.song.name)).toEqual(["Song 1", "Song 2", "Song 3 (Official Audio)"]);
    expect(plays.map((entry) => [entry.trackIds[0], entry.mode])).toEqual([["nd:aaaaaaaaaaa", "replace"], ["nd:ccccccccccc", "end"]]);
    expect(job.status).toBe("done");
    expect(job.tracks.map((entry) => entry.status)).toEqual(["playing", "failed", "queued"]);
    expect(job.tracks[1].error).toBe("Video unavailable");
    expect(job.tracks[2].title).toBe("Song 3 (Official Audio)");
  });

  it("gets a Mix's song and the songs after it", async () => {
    const seed = { song_id: "aaaaaaaaaaa", name: "Kto je dežo", artists: ["Marhule"], duration: 200 };
    const after = Array.from({ length: 12 }, (_, index) => ({ song_id: `m${String(index).padStart(10, "0")}`, name: `Mix ${index + 1}`, duration: 180 }));
    // The radio may lead with the seed itself; it isn't downloaded twice.
    const { importer, downloads, plays, done, resolved, similar } = setup([seed, ...after], { mix: [seed, ...after] });
    await importer.pair("123456");

    await importer.start({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=RDaaaaaaaaaaa&start_radio=1", groupId: "g1" });
    const job = await done;

    expect(resolved[0]).toBe("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(similar).toEqual([["Marhule", "Kto je dežo", MIX_SONGS]]);
    expect(downloads.map((entry) => entry.song.name)).toEqual(["Kto je dežo", ...after.slice(0, MIX_SONGS).map((song) => song.name)]);
    expect(plays.map((entry) => entry.mode)).toEqual(["replace", ...Array(MIX_SONGS).fill("end")]);
    expect(job.status).toBe("done");
  });

  it("still gets a Mix's song when the radio can't be read", async () => {
    const { importer, downloads, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }], { mix: new Error("YouTube Music did not answer") });
    await importer.pair("123456");
    await importer.start({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=RDaaaaaaaaaaa", groupId: "g1" });
    const job = await done;
    expect(downloads).toHaveLength(1);
    expect(job).toMatchObject({ status: "done", note: "Only the song: its Mix couldn't be read (YouTube Music did not answer)." });
  });

  it("asks for the whole playlist when the video was opened from one", async () => {
    const { importer, resolved, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }]);
    await importer.pair("123456");
    await importer.start({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLxyz", groupId: "g1" });
    await done;
    expect(resolved[0]).toBe("https://www.youtube.com/playlist?list=PLxyz");
  });

  it("only saves the songs when no room is given", async () => {
    const { importer, plays, added, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }]);
    await importer.pair("123456");
    await importer.start({ url: "https://youtu.be/aaaaaaaaaaa" });
    expect((await done).tracks[0].status).toBe("saved");
    expect(added).toEqual(["nd:aaaaaaaaaaa"]);
    expect(plays).toEqual([]);
  });

  it("still plays a song the playlist couldn't take, and says so", async () => {
    const { importer, plays, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }], { playlistFails: true });
    await importer.pair("123456");
    await importer.start({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" });
    const job = await done;
    expect(plays).toHaveLength(1);
    expect(job).toMatchObject({ status: "done", note: "Couldn't add songs to the YouTube playlist: Navidrome: HTTP 500." });
  });

  it("gives up on a song Navidrome never lists", async () => {
    const { importer, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }], { lag: 10_000 });
    await importer.pair("123456");
    await importer.start({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" });
    const job = await done;
    expect(job).toMatchObject({ status: "failed", error: "Downloaded, but Navidrome hasn't picked it up yet" });
  });

  it("saves a video under the artist and title given, and plays it", async () => {
    const song = { song_id: "8h4xp8OREjs", name: "Music for People Who Are Tired", artists: ["Some Channel"], duration: 3540 };
    const { importer, downloads, added, plays, done } = setup([song]);
    await importer.pair("123456");

    await importer.start({ url: "https://www.youtube.com/watch?v=8h4xp8OREjs", groupId: "g1", names: { artist: " jazzhousestudio ", title: "Tired" } });
    const job = await done;

    expect(downloads).toEqual([{ song, names: { artist: "jazzhousestudio", title: "Tired" } }]);
    expect(added).toEqual(["nd:8h4xp8OREjs"]);
    expect(plays).toEqual([{ trackIds: ["nd:8h4xp8OREjs"], groupId: "g1", mode: "replace" }]);
    expect(job).toMatchObject({ status: "done", tracks: [{ title: "Tired", artist: "jazzhousestudio", status: "playing" }] });
    expect(job.note).toBeUndefined();
  });

  it("saves a video whose own names don't fit in a file name under its id, and says so", async () => {
    const { importer, downloads, done } = setup([PADDED]);
    await importer.pair("123456");

    await importer.start({ url: "https://youtu.be/8h4xp8OREjs", groupId: "g1" });
    const job = await done;

    const channel = PADDED.artists[0];
    expect(downloads[0].names).toEqual({ title: "8h4xp8OREjs" });
    expect(job).toMatchObject({ status: "done", tracks: [{ title: "8h4xp8OREjs", artist: channel, status: "playing" }] });
    expect(job.note).toBe(`YouTube's name for a song was too long for a file, so it's saved as “${channel} - 8h4xp8OREjs”.`);
  });

  it("turns away names for a playlist, and names too long for a file", async () => {
    const { importer } = setup([]);
    await importer.pair("123456");
    await expect(importer.start({ url: "https://www.youtube.com/playlist?list=PLxyz", groupId: "g1", names: { title: "Mine" } })).rejects.toMatchObject({ status: 400 });
    await expect(importer.start({ url: "https://youtu.be/8h4xp8OREjs", names: { title: "ㅤ".repeat(81) } })).rejects.toMatchObject({ status: 400 });
    // Empty fields are no names at all.
    await expect(importer.start({ url: "https://www.youtube.com/playlist?list=PLxyz", names: { artist: " ", title: "" } })).resolves.toMatchObject({ status: "resolving" });
  });

  it("plays a link's video without downloading it", async () => {
    const { importer, videoPlays, downloads } = setup([]);
    await importer.playLink({ url: "https://www.youtube.com/watch?v=8h4xp8OREjs&list=RD8h4xp8OREjs", groupId: "g1" });
    await importer.playLink({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1", mode: "end" });
    expect(videoPlays).toEqual([
      { videoId: "8h4xp8OREjs", groupId: "g1", mode: "replace" },
      { videoId: "aaaaaaaaaaa", groupId: "g1", mode: "end" }
    ]);
    expect(downloads).toEqual([]);

    await expect(importer.playLink({ url: "https://www.youtube.com/playlist?list=PLxyz", groupId: "g1" })).rejects.toMatchObject({ status: 400 });
    await expect(importer.playLink({ url: "https://youtu.be/aaaaaaaaaaa" })).rejects.toMatchObject({ status: 400 });
  });

  it("previews a video with YouTube's names, and what a too-long one is saved as", async () => {
    const song = { song_id: "aaaaaaaaaaa", name: "Ripple", artists: ["Grateful Dead"], duration: 250 };
    const { importer } = setup([song, PADDED]);
    // Not paired yet: only what the link itself says.
    expect(await importer.preview("https://www.youtube.com/watch?v=aaaaaaaaaaa")).toEqual({ kind: "video", videoId: "aaaaaaaaaaa" });
    await importer.pair("123456");

    expect(await importer.preview("https://www.youtube.com/watch?v=aaaaaaaaaaa")).toEqual({ kind: "video", videoId: "aaaaaaaaaaa", title: "Ripple", artist: "Grateful Dead", durationSeconds: 250 });
    expect((await importer.preview("https://www.youtube.com/watch?v=8h4xp8OREjs")).shortenedTo).toEqual({ title: "8h4xp8OREjs" });
    expect(await importer.preview("https://www.youtube.com/playlist?list=PLxyz")).toEqual({ kind: "playlist", videoId: undefined });
  });

  it("still previews the link when Downtify can't look it up", async () => {
    const { importer } = setup([], { resolveFails: true });
    await importer.pair("123456");
    expect(await importer.preview("https://youtu.be/aaaaaaaaaaa")).toEqual({ kind: "video", videoId: "aaaaaaaaaaa" });
  });

  it("turns away links that aren't YouTube, and stays hidden without a Downtify address", async () => {
    const { importer } = setup([]);
    await importer.pair("123456");
    await expect(importer.start({ url: "https://example.com/x", groupId: "g1" })).rejects.toMatchObject({ status: 400 });

    const hidden = new YouTubeImporter({ playlist: "YouTube", pairingPath, search: vi.fn(), play: vi.fn(), onChange: vi.fn() });
    expect(await hidden.status()).toMatchObject({ available: false, paired: false });
    await expect(hidden.start({ url: "https://youtu.be/aaaaaaaaaaa" })).rejects.toMatchObject({ status: 503 });
  });
});
