import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YouTubeImportJob, YouTubeImportStatus, YouTubeLinkPreview } from "@misonos/sonos-protocol";
import { linkVideoId } from "./youtube.js";
import { useYouTubeLink, YOUTUBE_ACTION_KEY } from "./useYouTubeLink.js";
import { YouTubeLinkPanel } from "./YouTubeLinkPanel.js";

const STATUS: YouTubeImportStatus = { available: true, paired: true, username: "pepe", playlist: "YouTube", mixSongs: 10 };
const VIDEO = "https://www.youtube.com/watch?v=8h4xp8OREjs";

// The search box as App has it: Enter in the box submits the panel. groupId null is
// "This device", which has no Sonos room.
function Harness({ groupId = "g1", status = STATUS, onJob = () => {} }: { groupId?: string | null; status?: YouTubeImportStatus; onJob?: (job: YouTubeImportJob) => void }) {
  const [query, setQuery] = useState("");
  const link = useYouTubeLink({ url: query.trim(), status, groupId: groupId ?? undefined, groupName: "Kitchen", onJob, onStarted: () => setQuery("") });
  return (
    <>
      <form onSubmit={(event) => { event.preventDefault(); void link.submit(); }}>
        <input type="search" aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </form>
      <YouTubeLinkPanel controller={link} />
    </>
  );
}

describe("linkVideoId", () => {
  it("finds the video a link plays, and none in a plain playlist", () => {
    expect(linkVideoId("https://youtu.be/8h4xp8OREjs?si=x")).toBe("8h4xp8OREjs");
    expect(linkVideoId("https://www.youtube.com/watch?v=8h4xp8OREjs&list=RD8h4xp8OREjs")).toBe("8h4xp8OREjs");
    expect(linkVideoId("https://www.youtube.com/shorts/8h4xp8OREjs")).toBe("8h4xp8OREjs");
    expect(linkVideoId("https://www.youtube.com/playlist?list=PLxyz")).toBeUndefined();
  });
});

describe("the YouTube link panel", () => {
  let calls: { url: string; body?: unknown }[];
  let preview: YouTubeLinkPreview;

  beforeEach(() => {
    window.localStorage.clear();
    calls = [];
    preview = { kind: "video", videoId: "8h4xp8OREjs", title: "Music for People Who Are Tired", artist: "Jazz House", durationSeconds: 3540 };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/youtube/preview?")) return json(preview);
      if (url.endsWith("/api/youtube/import")) return json({ id: "job1", url: VIDEO, status: "resolving", tracks: [], startedAt: "2026-11-11T20:00:00Z" }, 202);
      if (url.endsWith("/api/youtube/play")) return json({ groupId: "g1", state: "PLAYING", updatedAt: "2026-11-11T20:00:00Z" });
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const paste = (link: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: link } });
  const posts = (path: string) => calls.filter((call) => call.url.endsWith(path)).map((call) => call.body);

  it("stays away until a YouTube link is in the box", () => {
    render(<Harness />);
    expect(screen.queryByRole("group", { name: "Play or download the link" })).toBeNull();
  });

  it("downloads a video under the artist and title typed, YouTube's own as placeholders", async () => {
    const onJob = vi.fn();
    render(<Harness onJob={onJob} />);
    paste(VIDEO);

    expect(screen.getByRole("button", { name: "Download" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Enter gets it from YouTube and plays it.");
    const artist = screen.getByRole("textbox", { name: "Artist" });
    const title = screen.getByRole("textbox", { name: "Title" });
    await waitFor(() => expect(title).toHaveAttribute("placeholder", "Music for People Who Are Tired"));
    expect(artist).toHaveAttribute("placeholder", "Jazz House");

    fireEvent.change(artist, { target: { value: " jazzhousestudio " } });
    fireEvent.change(title, { target: { value: "Tired" } });
    fireEvent.click(screen.getByRole("button", { name: "Download the link" }));

    await waitFor(() => expect(posts("/api/youtube/import")).toEqual([{ url: VIDEO, groupId: "g1", artist: "jazzhousestudio", title: "Tired" }]));
    await waitFor(() => expect(onJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job1" })));
    // The box emptied, and the panel with it: the job's progress takes over.
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });

  it("sends no names when the fields are left empty, so YouTube's are kept", async () => {
    render(<Harness />);
    paste(VIDEO);
    fireEvent.submit(screen.getByRole("searchbox", { name: "Search" }).closest("form")!);
    await waitFor(() => expect(posts("/api/youtube/import")).toEqual([{ url: VIDEO, groupId: "g1" }]));
  });

  it("says what a video whose name doesn't fit in a file is saved as, without its invisible padding", async () => {
    preview = { kind: "video", videoId: "8h4xp8OREjs", title: "ㅤ".repeat(100), artist: "ㅤㅤㅤꞋꞌꞋꞌ", shortenedTo: { title: "8h4xp8OREjs" } };
    render(<Harness />);
    paste(VIDEO);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("it's saved as “ꞋꞌꞋꞌ - 8h4xp8OREjs” unless you give it one."));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute("placeholder", "8h4xp8OREjs");
    expect(screen.getByRole("textbox", { name: "Artist" })).toHaveAttribute("placeholder", "ꞋꞌꞋꞌ");
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Tired" } });
    expect(screen.getByRole("status")).not.toHaveTextContent("saved as");
  });

  it("has no names to give a playlist", () => {
    render(<Harness />);
    paste("https://www.youtube.com/playlist?list=PLxyz");
    expect(screen.getByRole("status")).toHaveTextContent("Enter gets the playlist from YouTube and plays it.");
    expect(screen.queryByRole("textbox", { name: "Artist" })).toBeNull();
  });

  it("plays a video without downloading it, and remembers the choice", async () => {
    const first = render(<Harness />);
    paste(VIDEO);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    expect(screen.getByRole("status")).toHaveTextContent("Plays it on Kitchen from YouTube, without saving it.");
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    fireEvent.submit(screen.getByRole("searchbox", { name: "Search" }).closest("form")!);

    await waitFor(() => expect(posts("/api/youtube/play")).toEqual([{ url: VIDEO, groupId: "g1" }]));
    expect(posts("/api/youtube/import")).toEqual([]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Playing it on Kitchen, straight from YouTube."));
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");

    expect(window.localStorage.getItem(YOUTUBE_ACTION_KEY)).toBe("play");
    first.unmount();
    render(<Harness />);
    paste(VIDEO);
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "true");
  });

  it("won't play a playlist, or on this device, and says why", async () => {
    window.localStorage.setItem(YOUTUBE_ACTION_KEY, "play");
    const view = render(<Harness />);
    paste("https://www.youtube.com/playlist?list=PLxyz");
    expect(screen.getByRole("status")).toHaveTextContent("Play takes a single video. Download gets the whole playlist.");
    fireEvent.click(screen.getByRole("button", { name: "Play the link" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveClass("error"));
    view.unmount();

    render(<Harness groupId={null} />);
    paste(VIDEO);
    expect(screen.getByRole("status")).toHaveTextContent("Pick a Sonos room to play it on");
    expect(posts("/api/youtube/play")).toEqual([]);
  });

  it("asks to pair with Downtify before downloading", () => {
    render(<Harness status={{ ...STATUS, paired: false }} />);
    paste(VIDEO);
    expect(screen.getByRole("status")).toHaveTextContent("Pair MiSonos with Downtify in Settings → YouTube links to download.");
  });
});
