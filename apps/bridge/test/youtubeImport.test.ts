import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying, PlaybackMode, SourceBrowseItem, YouTubeImportJob } from "@misonos/sonos-protocol";
import type { DowntifySong } from "../src/downtify.js";
import { isYouTubeLink, pickTrack, YouTubeImporter, YouTubeImportError, type DowntifyApi } from "../src/youtubeImport.js";

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
  function setup(songs: DowntifySong[], options: { failDownload?: string; lag?: number; ownTitles?: Record<string, string> } = {}) {
    const downloaded = new Set<string>();
    const searches = new Map<string, number>();
    const downloads: Array<{ song: DowntifySong; playlist: string }> = [];
    const plays: Array<{ trackIds: string[]; groupId: string; mode: PlaybackMode }> = [];
    const events: YouTubeImportJob[] = [];
    let tokenUsed: string | undefined;
    let finished: (job: YouTubeImportJob) => void = () => undefined;
    const done = new Promise<YouTubeImportJob>((resolve) => { finished = resolve; });
    const client: DowntifyApi = {
      pair: async (code) => {
        if (code !== "123456") throw Object.assign(new Error("Wrong or expired pairing code"), { status: 401 });
        return { token: "dtfy_1_secret", user: { username: "pepe" } };
      },
      resolve: async (link) => {
        const id = new URL(link).searchParams.get("v");
        if (id) {
          const song = songs.find((entry) => entry.song_id === id);
          return song ? [{ ...song, name: options.ownTitles?.[id] ?? song.name }] : [];
        }
        return songs;
      },
      download: async (song, playlist) => {
        downloads.push({ song, playlist });
        if (song.song_id === options.failDownload) throw new Error("Video unavailable");
        downloaded.add(song.name ?? "");
        return `YouTube/${song.name}.opus`;
      }
    };
    const importer = new YouTubeImporter({
      endpoint: ENDPOINT,
      playlist: "YouTube",
      pairingPath,
      search: async (query) => {
        const count = (searches.get(query) ?? 0) + 1;
        searches.set(query, count);
        if (!downloaded.has(query) || count <= (options.lag ?? 0)) return [];
        const song = songs.find((entry) => (options.ownTitles?.[entry.song_id ?? ""] ?? entry.name) === query);
        return [{ id: "section:songs", title: "Songs", kind: "section" }, track(`nd:${song?.song_id}`, query, song?.duration)];
      },
      play: async (trackIds, groupId, mode) => {
        plays.push({ trackIds, groupId, mode });
        return { groupId, state: "PLAYING", updatedAt: new Date().toISOString() } as NowPlaying;
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
    return { importer, downloads, plays, events, done, tokenUsed: () => tokenUsed };
  }

  it("pairs with a Downtify code and keeps the token", async () => {
    const { importer } = setup([]);
    expect(await importer.status()).toEqual({ available: true, paired: false, username: undefined, playlist: "YouTube" });
    await expect(importer.start({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" })).rejects.toMatchObject({ status: 409 });

    expect(await importer.pair(" 123 456 ")).toMatchObject({ paired: true, username: "pepe" });
    expect(JSON.parse(await readFile(pairingPath, "utf8"))).toMatchObject({ token: "dtfy_1_secret", username: "pepe" });
    await expect(importer.pair("999999")).rejects.toBeInstanceOf(YouTubeImportError);

    expect(await importer.unpair()).toMatchObject({ paired: false });
  });

  it("downloads a video into the playlist, waits for Navidrome, and plays it", async () => {
    const song = { song_id: "aaaaaaaaaaa", name: "Ripple", artists: ["Grateful Dead"], duration: 250, url: "https://music.youtube.com/watch?v=aaaaaaaaaaa" };
    const { importer, downloads, plays, done, tokenUsed } = setup([song], { lag: 2 });
    await importer.pair("123456");

    const started = await importer.start({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", groupId: "g1" });
    expect(started.status).toBe("resolving");
    const job = await done;

    expect(tokenUsed()).toBe("dtfy_1_secret");
    expect(downloads).toEqual([{ song, playlist: "YouTube" }]);
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

  it("only saves the songs when no room is given", async () => {
    const { importer, plays, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }]);
    await importer.pair("123456");
    await importer.start({ url: "https://youtu.be/aaaaaaaaaaa" });
    expect((await done).tracks[0].status).toBe("saved");
    expect(plays).toEqual([]);
  });

  it("gives up on a song Navidrome never lists", async () => {
    const { importer, done } = setup([{ song_id: "aaaaaaaaaaa", name: "Ripple", duration: 250 }], { lag: 10_000 });
    await importer.pair("123456");
    await importer.start({ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" });
    const job = await done;
    expect(job).toMatchObject({ status: "failed", error: "Downloaded, but Navidrome hasn't picked it up yet" });
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
