import type { SourceBrowseItem } from "@misonos/sonos-protocol";
import { describe, expect, it } from "vitest";
import { orderFolders, orderSearchSections, savedOrder, SEARCH_SECTIONS, sectionKeyOf, sectionsInOrder } from "../src/musicOrder.js";

const section = (key: string): SourceBrowseItem => ({ id: `section:${key}`, title: key, kind: "section" });
const item = (id: string): SourceBrowseItem => ({ id, title: id, kind: "playable" });

// What Spotify sends: songs, artists, albums, playlists.
const spotifyResults = [
  section("songs"), item("s1"), item("s2"),
  section("artists"), item("ar1"),
  section("albums"), item("al1"),
  section("playlists"), item("p1"), item("p2")
];

const ids = (items: SourceBrowseItem[]) => items.map((entry) => entry.id);

describe("search sections", () => {
  it("moves whole sections, items and all, into the picked order", () => {
    expect(ids(orderSearchSections(spotifyResults, ["playlists", "songs", "artists", "albums"]))).toEqual([
      "section:playlists", "p1", "p2",
      "section:songs", "s1", "s2",
      "section:artists", "ar1",
      "section:albums", "al1"
    ]);
  });

  it("puts sections the order doesn't name after it, as the source sent them", () => {
    expect(ids(orderSearchSections(spotifyResults, ["albums"])).filter((id) => id.startsWith("section:"))).toEqual([
      "section:albums", "section:songs", "section:artists", "section:playlists"
    ]);
  });

  it("leaves results alone without an order, with one section, or with none", () => {
    expect(orderSearchSections(spotifyResults, undefined)).toBe(spotifyResults);
    const one = [section("songs"), item("s1")];
    expect(orderSearchSections(one, ["albums", "songs"])).toBe(one);
    const flat = [item("a"), item("b")];
    expect(orderSearchSections(flat, ["albums"])).toBe(flat);
  });

  it("keeps anything before the first section on top", () => {
    expect(ids(orderSearchSections([item("top"), ...spotifyResults], ["playlists"]))[0]).toBe("top");
  });

  it("reads a section's key from its id", () => {
    expect(sectionKeyOf(section("songs"))).toBe("songs");
    expect(sectionKeyOf({ id: "section:Songs:3", title: "Songs", kind: "section" })).toBe("songs");
  });

  it("lists a source's sections in the saved order, new ones last", () => {
    expect(sectionsInOrder(SEARCH_SECTIONS.spotify, ["playlists", "songs"]).map((entry) => entry.key)).toEqual(["playlists", "songs", "artists", "albums"]);
    expect(sectionsInOrder(SEARCH_SECTIONS.navidrome, ["playlists", "songs"]).map((entry) => entry.key)).toEqual(["songs", "artists", "albums"]);
  });

  it("keeps each Spotify login's order apart, falling back to Spotify's", () => {
    const orders = { "spotify|9:7": ["playlists"], spotify: ["albums"] };
    expect(savedOrder(orders, "spotify", "9:7")).toEqual(["playlists"]);
    expect(savedOrder(orders, "spotify", "9:5")).toEqual(["albums"]);
    expect(savedOrder(orders, "navidrome")).toBeUndefined();
  });
});

describe("top-level folders", () => {
  const folder = (id: string): SourceBrowseItem => ({ id, title: id, kind: "container" });
  const spotifyRoot = ["me:playlists", "me:tracks", "me:albums", "me:artists", "me:recent", "me:top"].map(folder);

  it("puts the named folders first, the rest after in the source's order", () => {
    expect(ids(orderFolders(spotifyRoot, ["me:top", "me:tracks"]))).toEqual(["me:top", "me:tracks", "me:playlists", "me:albums", "me:artists", "me:recent"]);
  });

  it("leaves the list as it is without an order, or with one it already follows", () => {
    expect(orderFolders(spotifyRoot, undefined)).toBe(spotifyRoot);
    expect(orderFolders(spotifyRoot, ["me:playlists"])).toBe(spotifyRoot);
  });

  it("ignores folders the source no longer has", () => {
    expect(ids(orderFolders(spotifyRoot, ["gone", "me:recent"]))[0]).toBe("me:recent");
  });
});
