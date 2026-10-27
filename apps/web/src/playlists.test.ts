import { describe, expect, it } from "vitest";
import type { SourceBrowseItem, SourceDescriptor } from "@misonos/sonos-protocol";
import { findPlaylistsFolder, pickPlaylistSource, type PlaylistSource } from "./playlists.js";

const folder = (id: string, title: string): SourceBrowseItem => ({ id, title, kind: "container" });

describe("findPlaylistsFolder", () => {
  it("finds Navidrome's and Spotify's Playlists folders", () => {
    expect(findPlaylistsFolder([folder("artists", "Artists"), folder("playlists", "Playlists")])?.id).toBe("playlists");
    expect(findPlaylistsFolder([folder("me:tracks", "Liked Songs"), folder("me:playlists", "Playlists")])?.id).toBe("me:playlists");
  });

  it("goes by the title when the id says nothing", () => {
    expect(findPlaylistsFolder([folder("node-7", "Playlists")])?.id).toBe("node-7");
  });

  it("finds nothing in a source without playlists", () => {
    expect(findPlaylistsFolder([folder("years", "By Year"), { id: "playlist:1", title: "Playlists", kind: "playable" }])).toBeUndefined();
  });
});

describe("pickPlaylistSource", () => {
  const source = (id: string): SourceDescriptor => ({ id, name: id, rootId: "root" });
  const found: PlaylistSource[] = [
    { source: source("navidrome"), folderId: "playlists" },
    { source: source("spotify"), folderId: "me:playlists" }
  ];

  it("uses the picked source, or the first one when none is picked or it's away", () => {
    expect(pickPlaylistSource(found, "spotify")?.source.id).toBe("spotify");
    expect(pickPlaylistSource(found, null)?.source.id).toBe("navidrome");
    expect(pickPlaylistSource(found, "tidal")?.source.id).toBe("navidrome");
  });

  it("shows nothing when switched off or before the sources are known", () => {
    expect(pickPlaylistSource(found, "off")).toBeNull();
    expect(pickPlaylistSource(null, "spotify")).toBeNull();
    expect(pickPlaylistSource([], null)).toBeNull();
  });
});
