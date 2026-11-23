import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "../src/api.js";
import { SEARCH_SECTION_ORDER_PREF } from "../src/prefs.js";
import { SearchOrderSettings } from "../src/SearchOrderSettings.js";

const account = (sn: number, name: string) => ({ sid: 9, sn, token: `t${sn}`, seenOn: [], uses: 1, name });

describe("Settings → Search results order", () => {
  let saved: Array<[string, unknown]>;

  beforeEach(() => {
    window.localStorage.clear();
    saved = [];
    vi.spyOn(bridgeApi, "listSources").mockResolvedValue([
      { id: "spotify", name: "Spotify" },
      { id: "navidrome", name: "Navidrome" },
      { id: "tunein", name: "TuneIn" }
    ] as Awaited<ReturnType<typeof bridgeApi.listSources>>);
    vi.spyOn(bridgeApi, "spotifyAccounts").mockResolvedValue({
      accounts: [account(5, "Mia"), account(7, "Pepe")],
      selected: { sid: 9, sn: 5, token: "t5", origin: "preference" }
    });
    vi.spyOn(bridgeApi, "getPreference").mockRejectedValue(new Error("404"));
    vi.spyOn(bridgeApi, "setPreference").mockImplementation(async (key: string, value: unknown) => {
      saved.push([key, value]);
      return undefined as never;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const rows = () => within(screen.getByRole("list", { name: /search sections/ })).getAllByRole("listitem").map((row) => row.textContent);

  it("orders one Spotify login's sections and saves them for that login only", async () => {
    render(<SearchOrderSettings customIcons={{}} sourcesVersion={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Spotify Pepe" }));
    expect(screen.getByRole("list", { name: "Spotify Pepe search sections" })).toBeInTheDocument();
    expect(rows()).toEqual(["1Songs", "2Artists", "3Albums", "4Playlists"]);

    // Playlists to the top: up three times.
    for (let step = 0; step < 3; step += 1) fireEvent.click(screen.getByRole("button", { name: "Move Playlists up" }));
    expect(rows()).toEqual(["1Playlists", "2Songs", "3Artists", "4Albums"]);
    expect(saved.at(-1)).toEqual([SEARCH_SECTION_ORDER_PREF.bridgeKey, JSON.stringify({ "spotify|9:7": ["playlists", "songs", "artists", "albums"] })]);

    // Mia keeps Spotify's own order.
    fireEvent.click(screen.getByRole("button", { name: "Spotify Mia" }));
    expect(rows()).toEqual(["1Songs", "2Artists", "3Albums", "4Playlists"]);
  });

  it("offers only sources whose search has sections, and resets an order", async () => {
    render(<SearchOrderSettings customIcons={{}} sourcesVersion={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Navidrome" }));
    expect(screen.queryByRole("button", { name: "TuneIn" })).not.toBeInTheDocument();
    expect(rows()).toEqual(["1Artists", "2Albums", "3Songs"]);
    expect(screen.getByRole("button", { name: "Move Artists up" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Move Artists down" }));
    expect(rows()).toEqual(["1Albums", "2Artists", "3Songs"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
    expect(rows()).toEqual(["1Artists", "2Albums", "3Songs"]);
    expect(screen.queryByRole("button", { name: "Reset order" })).not.toBeInTheDocument();
  });
});
