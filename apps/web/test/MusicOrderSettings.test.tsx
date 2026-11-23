import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "../src/api.js";
import { MusicOrderSettings } from "../src/MusicOrderSettings.js";
import { FOLDER_ORDER_PREF, SEARCH_SECTION_ORDER_PREF } from "../src/prefs.js";

const account = (sn: number, name: string) => ({ sid: 9, sn, token: `t${sn}`, seenOn: [], uses: 1, name });
const folder = (id: string, title: string) => ({ id, title, kind: "container" as const });

const ROOTS: Record<string, ReturnType<typeof folder>[]> = {
  spotify: [
    folder("me:playlists", "Playlists"), folder("me:tracks", "Liked Songs"), folder("me:albums", "Albums"),
    folder("me:artists", "Artists"), folder("me:recent", "Recently Played"), folder("me:top", "Top Tracks")
  ],
  navidrome: [folder("artists", "Artists"), folder("albums", "Albums"), folder("playlists", "Playlists"), folder("genres", "Genres"), folder("starred", "Starred")],
  "youtube-music": [folder("home", "Home"), folder("new-releases", "New Releases"), folder("charts", "Charts")]
};

describe("Settings → Order in Music", () => {
  let saved: Array<[string, unknown]>;

  beforeEach(() => {
    window.localStorage.clear();
    saved = [];
    vi.spyOn(bridgeApi, "listSources").mockResolvedValue([
      { id: "spotify", name: "Spotify" },
      { id: "navidrome", name: "Navidrome" },
      { id: "youtube-music", name: "YouTube Music" }
    ] as Awaited<ReturnType<typeof bridgeApi.listSources>>);
    vi.spyOn(bridgeApi, "spotifyAccounts").mockResolvedValue({
      accounts: [account(6, "Mia"), account(3, "PK")],
      selected: { sid: 9, sn: 3, token: "t3", origin: "preference" }
    });
    vi.spyOn(bridgeApi, "browseSource").mockImplementation(async (sourceId: string) => ({ id: "root", total: ROOTS[sourceId].length, items: ROOTS[sourceId] }));
    vi.spyOn(bridgeApi, "getPreference").mockRejectedValue(new Error("404"));
    vi.spyOn(bridgeApi, "setPreference").mockImplementation(async (key: string, value: unknown) => {
      saved.push([key, value]);
      return undefined as never;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const rows = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem").map((row) => row.textContent);
  const move = (list: string, title: string, direction: "up" | "down", times = 1) => {
    for (let step = 0; step < times; step += 1) {
      fireEvent.click(within(screen.getByRole("list", { name: list })).getByRole("button", { name: `Move ${title} ${direction}` }));
    }
  };

  it("orders a Spotify login's folders and search sections, each saved for that login", async () => {
    render(<MusicOrderSettings customIcons={{}} sourcesVersion={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Spotify PK" }));
    await screen.findByRole("list", { name: "Spotify PK folders" });
    expect(rows("Spotify PK folders")).toEqual(["1Playlists", "2Liked Songs", "3Albums", "4Artists", "5Recently Played", "6Top Tracks"]);

    move("Spotify PK folders", "Top Tracks", "up", 4);
    expect(rows("Spotify PK folders")).toEqual(["1Playlists", "2Top Tracks", "3Liked Songs", "4Albums", "5Artists", "6Recently Played"]);
    expect(saved.at(-1)).toEqual([FOLDER_ORDER_PREF.bridgeKey, JSON.stringify({ "spotify|9:3": ["me:playlists", "me:top", "me:tracks", "me:albums", "me:artists", "me:recent"] })]);

    move("Spotify PK search sections", "Playlists", "up", 3);
    expect(rows("Spotify PK search sections")).toEqual(["1Playlists", "2Songs", "3Artists", "4Albums"]);
    expect(saved.at(-1)).toEqual([SEARCH_SECTION_ORDER_PREF.bridgeKey, JSON.stringify({ "spotify|9:3": ["playlists", "songs", "artists", "albums"] })]);

    // Mia keeps Spotify's own orders.
    fireEvent.click(screen.getByRole("button", { name: "Spotify Mia" }));
    await screen.findByRole("list", { name: "Spotify Mia folders" });
    expect(rows("Spotify Mia folders")[1]).toBe("2Liked Songs");
    expect(rows("Spotify Mia search sections")[0]).toBe("1Songs");
  });

  it("orders any source's folders, and its search sections only when its search has them", async () => {
    render(<MusicOrderSettings customIcons={{}} sourcesVersion={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "YouTube Music" }));
    await screen.findByRole("list", { name: "YouTube Music folders" });
    expect(rows("YouTube Music folders")).toEqual(["1Home", "2New Releases", "3Charts"]);
    expect(screen.queryByRole("list", { name: "YouTube Music search sections" })).not.toBeInTheDocument();

    move("YouTube Music folders", "Charts", "up", 2);
    expect(rows("YouTube Music folders")[0]).toBe("1Charts");
    fireEvent.click(screen.getByRole("button", { name: "Reset the order of YouTube Music folders" }));
    expect(rows("YouTube Music folders")).toEqual(["1Home", "2New Releases", "3Charts"]);
    expect(screen.queryByRole("button", { name: /Reset the order/ })).not.toBeInTheDocument();
  });
});
