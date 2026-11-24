import { describe, expect, it } from "vitest";
import { shownSourceId, speakerOnlySources } from "../src/deviceSources.js";

const sources = [
  { id: "spotify", name: "Spotify", capabilities: ["search", "sonos-only"] },
  { id: "youtube-music", name: "YouTube Music", capabilities: ["search"] },
  { id: "navidrome", name: "Navidrome" }
];

describe("speakerOnlySources", () => {
  it("names the sources that play only through the speakers, with why", () => {
    expect(speakerOnlySources(sources)).toEqual({ spotify: "Spotify plays only on Sonos speakers: pick a room" });
    expect(speakerOnlySources(sources.slice(1))).toEqual({});
  });
});

describe("shownSourceId", () => {
  const blocked = speakerOnlySources(sources);

  it("keeps the chosen source while it can play", () => {
    expect(shownSourceId(sources, "navidrome", blocked)).toBe("navidrome");
    expect(shownSourceId(sources, "spotify", {})).toBe("spotify");
    expect(shownSourceId(sources, null, blocked)).toBeNull();
  });

  it("shows the first source that can play in place of a blocked one", () => {
    expect(shownSourceId(sources, "spotify", blocked)).toBe("youtube-music");
  });

  it("stays on the chosen source when none can play", () => {
    expect(shownSourceId(sources.slice(0, 1), "spotify", blocked)).toBe("spotify");
  });
});
