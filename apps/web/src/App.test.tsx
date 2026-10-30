import type { BridgeEvent } from "@misonos/sonos-protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  });

  it("renders the controller shell", async () => {
    render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);
    expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
    expect(await screen.findByText(/^(Mint|Amber|Sky|Coral|Lilac|Lime|Pink|Olive)$/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Song" })).toBeInTheDocument();
    expect(await screen.findByRole("slider", { name: "Playback progress (drag to seek)" })).toBeInTheDocument();
  });

  it("collapses the queue and plays a playlist from the grid, by click or key", async () => {
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
      return json({ groups: [{ id: "g1", coordinatorId: "z1", coordinatorName: "Kitchen", zones: [] }], zones: [] });
    }));
    const { container } = render(<DialogProvider><FavoritesProvider><LocalPlayerProvider><App /></LocalPlayerProvider></FavoritesProvider></DialogProvider>);

    const tile = await screen.findByRole("button", { name: "Play Road Trip" });
    expect(tile).toHaveAttribute("aria-keyshortcuts", "1");
    await waitFor(() => expect(container.querySelector(".queue-list")).not.toBeNull());

    const queueToggle = screen.getByRole("button", { name: "Queue" });
    fireEvent.click(queueToggle);
    expect(queueToggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".queue-list")).toBeNull();
    fireEvent.keyDown(document.body, { key: "q" });
    expect(queueToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(tile);
    await waitFor(() => expect(plays).toHaveLength(1));
    expect(plays[0]).toMatchObject({ trackIds: ["t1", "t2"], groupId: "g1", mode: "replace" });
    await waitFor(() => expect(tile).not.toBeDisabled());
    fireEvent.keyDown(document.body, { key: "1", code: "Digit1" });
    await waitFor(() => expect(plays).toHaveLength(2));
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
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
