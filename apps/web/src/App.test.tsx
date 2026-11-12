import type { BridgeEvent } from "@misonos/sonos-protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { DialogProvider } from "./dialogs.js";
import { FavoritesProvider } from "./favorites.js";
import { LocalPlayerProvider } from "./localPlayer.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, EventListener>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  /** Delivers a bridge event to every open stream, as the bridge would. */
  static emit(event: BridgeEvent) {
    for (const source of FakeEventSource.instances) {
      if (!source.closed) source.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }

  close() {
    this.closed = true;
  }
}

// Library's own lists (MiSonos playlists, favorites, recents): empty in these tests.
function libraryLists(url: string): boolean {
  return /\/api\/(playlists|favorites|recently-played|sources\/settings)(\?|$)/.test(url) || url.endsWith("/recent-queues");
}

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([]);
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", position: "0:01:07", duration: "0:04:04", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([{ id: "q1", title: "Song" }]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The screen lives in the URL (#settings, #music): start every test on Playing.
    window.history.replaceState(null, "", "/");
  });

  it("keeps the song in reach on Music, and goes back to Playing from it", async () => {
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    const tabs = await screen.findByRole("navigation", { name: "Screens" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Music" }));
    expect(window.location.hash).toBe("#music");
    expect(within(tabs).getByRole("button", { name: "Music" })).toHaveAttribute("aria-current", "page");

    const bar = await screen.findByRole("region", { name: "Now playing" });
    expect(within(bar).getByText("Song")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Pause" })).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: /^Open Playing/ }));
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(await screen.findByRole("button", { name: "Previous" })).toBeInTheDocument();
  });

  it("renders the controller shell", async () => {
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
    expect(await screen.findByText(/^(Mint|Amber|Sky|Coral|Lilac|Lime|Pink|Olive)$/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Song" })).toBeInTheDocument();
    expect(await screen.findByRole("slider", { name: "Playback progress (drag to seek)" })).toBeInTheDocument();
  });

  it("collapses the queue, and plays a Navidrome playlist from Library's grid by click or key", async () => {
    window.localStorage.clear();
    const plays: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([{ id: "navidrome", name: "Navidrome", rootId: "root", capabilities: ["search"] }]);
      if (url.endsWith("/api/sources/navidrome/browse")) {
        return json({ id: "root", total: 2, items: [{ id: "artists", title: "Artists", kind: "container" }, { id: "playlists", title: "Playlists", kind: "container" }] });
      }
      if (url.endsWith("/browse?id=playlists")) return json({ id: "playlists", total: 1, items: [{ id: "pl:1", title: "Road Trip", kind: "album" }] });
      if (url.endsWith("/browse?id=pl%3A1")) {
        return json({ id: "pl:1", total: 2, items: [{ id: "t1", title: "One", kind: "playable" }, { id: "t2", title: "Two", kind: "playable" }] });
      }
      if (url.endsWith("/api/sources/navidrome/play")) {
        plays.push(JSON.parse(String(init?.body)));
        return json({ groupId: "g1", state: "PLAYING", title: "One", updatedAt: new Date().toISOString() });
      }
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", position: "0:01:07", duration: "0:04:04", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([{ id: "q1", title: "Song" }]);
      if (libraryLists(url)) return json([]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    const { container } = render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    await waitFor(() => expect(container.querySelector(".queue-list")).not.toBeNull());
    // The source's playlists live in Library now, not under the queue.
    expect(screen.queryByRole("region", { name: "Navidrome playlists" })).toBeNull();

    const queueToggle = screen.getByRole("button", { name: "Queue" });
    fireEvent.click(queueToggle);
    expect(queueToggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".queue-list")).toBeNull();
    fireEvent.keyDown(document.body, { key: "q" });
    expect(queueToggle).toHaveAttribute("aria-expanded", "true");
    // Anywhere on the title row toggles too, but not the row's own buttons.
    const queueHeading = queueToggle.closest(".section-heading")!;
    fireEvent.click(queueHeading.querySelector(".heading-actions > span")!);
    expect(queueToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(queueHeading);
    expect(queueToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(within(screen.getByRole("navigation", { name: "Screens" })).getByRole("button", { name: /Library/ }));
    const tile = await screen.findByRole("button", { name: "Play Road Trip" });
    expect(tile).toHaveAttribute("aria-keyshortcuts", "1");
    // MiSonos's own playlists sit beside them, told apart by their label, with the count
    // where the main screen's cards have theirs.
    const own = screen.getByRole("region", { name: "MiSonos playlists" });
    expect(within(own).getByText("MiSonos")).toBeInTheDocument();
    expect(within(own).getByText("0").closest(".heading-actions")).not.toBeNull();

    fireEvent.click(tile);
    await waitFor(() => expect(plays).toHaveLength(1));
    expect(plays[0]).toMatchObject({ trackIds: ["t1", "t2"], groupId: "g1", mode: "replace" });
    await waitFor(() => expect(tile).not.toBeDisabled());
    fireEvent.keyDown(document.body, { key: "1", code: "Digit1" });
    await waitFor(() => expect(plays).toHaveLength(2));

    const playlistsToggle = within(screen.getByRole("region", { name: "Navidrome playlists" })).getByRole("button", { name: "Playlists" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh playlists" }));
    expect(playlistsToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(playlistsToggle.closest(".section-heading")!.querySelector(".playlists-source")!);
    expect(playlistsToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(playlistsToggle);
    expect(playlistsToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens Music's top-level folders in place, and keeps them open after a look inside", async () => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([{ id: "navidrome", name: "Navidrome", rootId: "root", capabilities: ["search"] }]);
      if (url.endsWith("/api/sources/navidrome/browse")) {
        return json({ id: "root", total: 2, items: [{ id: "artists", title: "Artists", kind: "container" }, { id: "playlists", title: "Playlists", kind: "container" }] });
      }
      if (url.endsWith("/browse?id=playlists")) return json({ id: "playlists", total: 1, items: [{ id: "pl:1", title: "Road Trip", kind: "album" }] });
      if (url.endsWith("/browse?id=pl%3A1")) {
        return json({ id: "pl:1", total: 2, items: [{ id: "t1", title: "One", kind: "playable" }, { id: "t2", title: "Two", kind: "playable" }] });
      }
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      if (libraryLists(url)) return json([]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Screens" })).getByRole("button", { name: /Music/ }));

    const browser = within(await screen.findByRole("region", { name: "Source browser" }));
    const playlists = await browser.findByRole("button", { name: "Playlists" });
    expect(playlists).toHaveAttribute("aria-expanded", "false");
    expect(browser.getByRole("button", { name: "Artists" })).toHaveAttribute("aria-expanded", "false");

    // It opens where it is, with its count on the right, like the cards elsewhere.
    fireEvent.click(playlists);
    const roadTrip = await browser.findByRole("button", { name: "Road Trip" });
    expect(playlists).toHaveAttribute("aria-expanded", "true");
    expect(playlists.closest(".section-heading")!.querySelector(".heading-actions > span")).toHaveTextContent("1");
    expect(browser.getByRole("button", { name: "Artists" })).toHaveAttribute("aria-expanded", "false");

    // A playlist in it opens as its own list, its path starting at the folder.
    fireEvent.click(roadTrip);
    expect(await browser.findByText("One")).toBeInTheDocument();
    const path = within(browser.getByRole("navigation", { name: "Path" }));
    expect(path.getByRole("button", { name: "Playlists" })).toBeInTheDocument();
    expect(path.getByRole("button", { name: "Road Trip" })).toBeInTheDocument();

    // Back at the top, the folder is still open, and it stays open next time.
    fireEvent.click(path.getByRole("button", { name: "Return to root" }));
    expect(await browser.findByRole("button", { name: "Road Trip" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("misonos.music.openFolders") ?? "{}")).toEqual({ "navidrome:root": ["playlists"] });
  });

  it("searches from the main screen and shows the results in Music", async () => {
    window.localStorage.clear();
    const searches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([{ id: "navidrome", name: "Navidrome", rootId: "root", capabilities: ["search"] }]);
      if (url.endsWith("/api/sources/navidrome/browse")) return json({ id: "root", total: 1, items: [{ id: "artists", title: "Artists", kind: "container" }] });
      if (url.includes("/api/sources/navidrome/search?")) {
        searches.push(url);
        return json({ id: "search", total: 1, items: [{ id: "t9", title: "Ripple", kind: "playable" }] });
      }
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    const box = await screen.findByRole("searchbox", { name: "Search Navidrome" });
    await waitFor(() => expect(box).not.toBeDisabled());
    // The search card sits right under Now Playing.
    expect(box.closest(".main-search")?.previousElementSibling).toHaveAttribute("aria-label", "Now playing");
    fireEvent.change(box, { target: { value: "ripple" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(searches).toHaveLength(1));
    expect(searches[0]).toContain("q=ripple");
    // The results open in Music, whose own box holds the same query and searches again in place.
    expect(await screen.findByText("Ripple")).toBeInTheDocument();
    const musicBox = screen.getByRole("searchbox", { name: "Search Navidrome" });
    expect(musicBox).not.toBe(box);
    expect(musicBox).toHaveValue("ripple");
    fireEvent.change(musicBox, { target: { value: "wharf rat" } });
    fireEvent.submit(musicBox.closest("form")!);
    await waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[1]).toContain("q=wharf%20rat");
  });

  it("searches for a pasted YouTube link like anything else while YouTube Music is off", async () => {
    const searches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      // YouTube Music is switched off, so it isn't listed; Downtify is still paired.
      if (url.endsWith("/api/sources")) return json([{ id: "navidrome", name: "Navidrome", rootId: "root", capabilities: ["search"] }]);
      if (url.endsWith("/api/sources/navidrome/browse")) return json({ id: "root", total: 0, items: [] });
      if (url.includes("/search?")) {
        searches.push(url);
        return json({ id: "search", total: 0, items: [] });
      }
      if (url.endsWith("/api/youtube/status")) return json({ available: true, paired: true, username: "pepe", playlist: "YouTube", mixSongs: 10 });
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    const box = await screen.findByRole("searchbox", { name: "Search Navidrome" });
    await waitFor(() => expect(box).toHaveAttribute("placeholder", "Search Navidrome"));
    fireEvent.change(box, { target: { value: "https://youtu.be/aaaaaaaaaaa" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(searches).toHaveLength(1));
    expect(searches[0]).toContain(encodeURIComponent("https://youtu.be/aaaaaaaaaaa"));
  });

  it("gets a pasted YouTube link instead of searching for it, and shows how it's going", async () => {
    window.localStorage.clear();
    FakeEventSource.instances = [];
    const searches: string[] = [];
    const imports: unknown[] = [];
    let playlistLoads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) {
        return json([
          { id: "navidrome", name: "Navidrome", rootId: "root", capabilities: ["search"] },
          { id: "youtube-music", name: "YouTube Music", rootId: "home", capabilities: ["search"] }
        ]);
      }
      if (url.endsWith("/api/sources/navidrome/browse")) return json({ id: "root", total: 2, items: [{ id: "artists", title: "Artists", kind: "container" }, { id: "playlists", title: "Playlists", kind: "container" }] });
      if (url.endsWith("/api/sources/youtube-music/browse")) return json({ id: "home", total: 0, items: [] });
      if (url.endsWith("/browse?id=playlists")) {
        playlistLoads += 1;
        return json({ id: "playlists", total: 1, items: [{ id: "pl:1", title: "Road Trip", kind: "album" }] });
      }
      if (url.includes("/search?")) {
        searches.push(url);
        return json({ id: "search", total: 0, items: [] });
      }
      if (url.endsWith("/api/youtube/status")) return json({ available: true, paired: true, username: "pepe", playlist: "YouTube", mixSongs: 10 });
      if (url.endsWith("/api/youtube/import")) {
        imports.push(JSON.parse(String(init?.body)));
        return json({ id: "job1", url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1", status: "resolving", tracks: [], startedAt: "2026-11-03T10:00:00Z" });
      }
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      if (libraryLists(url)) return json([]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    const screens = within(await screen.findByRole("navigation", { name: "Screens" }));

    // Library has shown the Navidrome playlists once; then back to Playing.
    fireEvent.click(screens.getByRole("button", { name: /Library/ }));
    await screen.findByRole("button", { name: "Play Road Trip" });
    fireEvent.click(screens.getByRole("button", { name: /Playing/ }));

    const box = await screen.findByRole("searchbox", { name: "Search Navidrome" });
    await waitFor(() => expect(box).toHaveAttribute("placeholder", "Search Navidrome or paste a YouTube link"));
    const card = within(box.closest(".main-search") as HTMLElement);
    fireEvent.change(box, { target: { value: "https://youtu.be/aaaaaaaaaaa" } });
    expect(card.getByRole("status")).toHaveTextContent("Enter gets it from YouTube and plays it.");
    fireEvent.submit(box.closest("form")!);

    await waitFor(() => expect(imports).toEqual([{ url: "https://youtu.be/aaaaaaaaaaa", groupId: "g1" }]));
    expect(searches).toEqual([]);
    // It stays on the main screen, the box emptied, with the import's progress under it.
    expect(box).toBeVisible();
    await waitFor(() => expect(box).toHaveValue(""));
    expect(card.getByRole("status")).toHaveTextContent("Looking up the YouTube link…");

    const loadsBefore = playlistLoads;
    act(() => FakeEventSource.emit({
      type: "youtube-import",
      at: "2026-11-03T10:00:05Z",
      payload: {
        id: "job1",
        url: "https://youtu.be/aaaaaaaaaaa",
        groupId: "g1",
        status: "done",
        tracks: [{ title: "Ripple", artist: "Grateful Dead", status: "playing" }],
        startedAt: "2026-11-03T10:00:00Z",
        finishedAt: "2026-11-03T10:00:05Z"
      }
    }));
    expect(card.getByRole("status")).toHaveTextContent("Playing “Ripple”.");
    fireEvent.click(card.getByRole("button", { name: "Dismiss" }));
    expect(card.queryByRole("status")).toBeNull();
    // The song is in the YouTube playlist now, so Library loads the playlists again.
    fireEvent.click(screens.getByRole("button", { name: /Library/ }));
    await screen.findByRole("button", { name: "Play Road Trip" });
    await waitFor(() => expect(playlistLoads).toBeGreaterThan(loadsBefore));
  });

  it("shows a volume change pushed by the bridge without waiting for the next poll", async () => {
    FakeEventSource.instances = [];
    const zones = [{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }];
    const group = { id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/groups")) return json([group]);
      if (url.endsWith("/api/zones")) return json(zones);
      if (url.endsWith("/api/sources")) return json([]);
      // Polls keep answering the old volume, so only the pushed event can move the slider.
      if (url.endsWith("/api/zones/z1/volume")) return json({ id: "z1", volume: 12, muted: false });
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      return json({ groups: [group], zones });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    const slider = await screen.findByRole("slider", { name: "Kitchen volume" });
    await waitFor(() => expect(slider).toHaveValue("12"));
    await waitFor(() => expect(FakeEventSource.instances.some((source) => !source.closed)).toBe(true));
    act(() => FakeEventSource.emit({ type: "volume", payload: { groupId: "g1", zones: [{ id: "z1", volume: 31, muted: false }] }, at: new Date().toISOString() }));
    await waitFor(() => expect(slider).toHaveValue("31"));
  });

  it("evens out the rooms of a group to the group volume", async () => {
    const zones = [
      { id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true },
      { id: "z2", uuid: "z2", name: "Office", ipAddress: "10.0.0.3", location: "", visible: true }
    ];
    const group = { id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones };
    const roomVolumes: Record<string, number> = { z1: 7, z2: 11 };
    const sets: Array<{ zone: string; volume: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/groups")) return json([group]);
      if (url.endsWith("/api/zones")) return json(zones);
      if (url.endsWith("/api/sources")) return json([]);
      if (url.endsWith("/api/groups/g1/volume")) return json({ id: "g1", volume: 9, muted: false });
      const zoneVolume = url.match(/\/api\/zones\/(z\d)\/volume$/);
      if (zoneVolume) {
        const zone = zoneVolume[1];
        if (init?.method === "POST") {
          const { volume } = JSON.parse(String(init.body)) as { volume: number };
          sets.push({ zone, volume });
          roomVolumes[zone] = volume;
        }
        return json({ id: zone, volume: roomVolumes[zone], muted: false });
      }
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      return json({ groups: [group], zones });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    const groupSlider = await screen.findByRole("slider", { name: /group volume$/ });
    await waitFor(() => expect(groupSlider).toHaveValue("9"));
    fireEvent.pointerDown(groupSlider);
    const evenOut = await screen.findByRole("button", { name: "Even out" });
    await waitFor(() => expect(evenOut).not.toBeDisabled());
    fireEvent.click(evenOut);
    await waitFor(() => expect(sets).toEqual(expect.arrayContaining([{ zone: "z1", volume: 9 }, { zone: "z2", volume: 9 }])));
    await waitFor(() => expect(evenOut).toBeDisabled());
  });

  it("plays the queue from a row's play button, and pauses the row that's playing", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let nowPlaying = { groupId: "g1", state: "PLAYING", title: "One", playlistPosition: 1, updatedAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/groups")) return json([{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }]);
      if (url.endsWith("/api/zones")) return json([{ id: "z1", uuid: "z1", name: "Kitchen", ipAddress: "10.0.0.2", location: "", visible: true }]);
      if (url.endsWith("/api/sources")) return json([]);
      if (url.endsWith("/queue/play-index") || url.endsWith("/transport")) {
        const body = JSON.parse(String(init?.body)) as { index?: number; action?: string };
        calls.push({ path: url.slice(url.lastIndexOf("/") + 1), body });
        nowPlaying = body.index
          ? { ...nowPlaying, state: "PLAYING", title: "Three", playlistPosition: body.index }
          : { ...nowPlaying, state: body.action === "pause" ? "PAUSED_PLAYBACK" : "PLAYING" };
        return json(nowPlaying);
      }
      if (url.endsWith("/now-playing")) return json(nowPlaying);
      if (url.endsWith("/queue")) return json([{ id: "q1", title: "One" }, { id: "q2", title: "Two" }, { id: "q3", title: "Three" }]);
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    // The row that's playing pauses instead of starting over; the others play from there.
    fireEvent.click(await screen.findByRole("button", { name: "Pause One" }));
    await waitFor(() => expect(calls).toEqual([{ path: "transport", body: { action: "pause" } }]));
    fireEvent.click(await screen.findByRole("button", { name: "Resume One" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ path: "transport", body: { action: "play" } });

    fireEvent.click(screen.getByRole("button", { name: "Play from Three" }));
    // Sonos counts queue tracks from 1.
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toEqual({ path: "play-index", body: { index: 3 } });
    expect(await screen.findByRole("button", { name: "Pause Three" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play from One" })).toBeInTheDocument();
  });

  it("shows a Sub level slider for a room that has a Sub, and sets it", async () => {
    const zones = [
      { id: "z1", uuid: "z1", name: "Living Room", ipAddress: "10.0.0.2", location: "", visible: true, hasSub: true },
      { id: "z2", uuid: "z2", name: "Office", ipAddress: "10.0.0.3", location: "", visible: true }
    ];
    const group = { id: "g1", coordinatorId: "z1", coordinatorName: "Living Room", zones };
    const sets: unknown[] = [];
    let subGain = -2;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/groups")) return json([group]);
      if (url.endsWith("/api/zones")) return json(zones);
      if (url.endsWith("/api/sources")) return json([]);
      const eq = url.match(/\/api\/zones\/(z\d)\/eq$/);
      if (eq) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { subGain?: number };
          sets.push(body);
          if (body.subGain !== undefined) subGain = body.subGain;
        }
        return json({ id: eq[1], bass: 0, treble: 0, loudness: false, ...(eq[1] === "z1" ? { subGain } : {}) });
      }
      if (url.endsWith("/api/eq-presets")) return json([]);
      if (url.endsWith("/api/alarms")) return json([]);
      if (url.endsWith("/now-playing")) return json({ groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() });
      if (url.endsWith("/queue")) return json([]);
      if (url.endsWith("/api/discover")) return json({ groups: [group], zones });
      // The rest of Settings (sources, services, alarms) isn't under test: let it fail quietly.
      return new Response("{}", { status: 404 });
    }));
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    fireEvent.click(await screen.findByLabelText("Settings"));
    const sub = await screen.findByRole("slider", { name: "Sub level" });
    expect(sub).toHaveValue("-2");
    expect(sub).toHaveAttribute("min", "-15");
    expect(sub).toHaveAttribute("max", "15");
    fireEvent.change(sub, { target: { value: "4" } });
    fireEvent.pointerUp(sub);
    await waitFor(() => expect(sets).toEqual([{ subGain: 4 }]));

    // A room without a Sub has just bass and treble.
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "z2" } });
    await waitFor(() => expect(screen.queryByRole("slider", { name: "Sub level" })).toBeNull());
    expect(screen.getByRole("slider", { name: "Bass" })).toBeInTheDocument();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
