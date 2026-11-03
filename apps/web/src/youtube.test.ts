import type { YouTubeImportJob, YouTubeImportTrack } from "@misonos/sonos-protocol";
import { describe, expect, it } from "vitest";
import { describeImport, isYouTubeLink } from "./youtube.js";

function job(status: YouTubeImportJob["status"], tracks: YouTubeImportTrack[], extra: Partial<YouTubeImportJob> = {}): YouTubeImportJob {
  return { id: "j", url: "https://youtu.be/x", groupId: "g1", status, tracks, startedAt: "2026-11-03T10:00:00Z", ...extra };
}

describe("isYouTubeLink", () => {
  it("takes YouTube links and leaves searches alone", () => {
    expect(isYouTubeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeLink("https://music.youtube.com/playlist?list=PL1")).toBe(true);
    expect(isYouTubeLink("youtu.be/dQw4w9WgXcQ")).toBe(false);
    expect(isYouTubeLink("youtube")).toBe(false);
    expect(isYouTubeLink("https://example.com/youtube.com")).toBe(false);
  });
});

describe("describeImport", () => {
  it("tells where a playlist's download is", () => {
    const tracks: YouTubeImportTrack[] = [
      { title: "One", status: "playing" },
      { title: "Two", status: "downloading" },
      { title: "Three", status: "waiting" }
    ];
    expect(describeImport(job("running", tracks), "YouTube")).toBe("Downloading “Two” (2 of 3)…");
    expect(describeImport(job("running", [{ title: "One", status: "finding" }]), "YouTube")).toBe("Adding “One” to Navidrome…");
  });

  it("sums up a finished import, failures included", () => {
    expect(describeImport(job("done", [{ title: "One", status: "playing" }]), "YouTube")).toBe("Playing “One”.");
    expect(describeImport(job("done", [
      { title: "One", status: "playing" },
      { title: "Two", status: "failed", error: "Video unavailable" },
      { title: "Three", status: "queued" }
    ]), "YouTube")).toBe("Playing “One”, with 1 more queued. “Two” failed: Video unavailable");
    expect(describeImport(job("done", [{ title: "One", status: "saved" }, { title: "Two", status: "saved" }], { groupId: undefined }), "YouTube"))
      .toBe("Saved 2 songs to the YouTube playlist.");
    expect(describeImport(job("failed", [], { error: "Unsupported URL" }), "YouTube")).toBe("Couldn't get it from YouTube: Unsupported URL");
  });
});
