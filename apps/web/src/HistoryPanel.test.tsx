import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayHistoryChange, PlayHistoryEntry } from "@misonos/sonos-protocol";
import { DialogProvider } from "./dialogs.js";
import { applyChange, byDay, dayLabel } from "./history.js";
import { HistoryPanel } from "./HistoryPanel.js";

const NOW = new Date(2026, 10, 11, 20, 0); // Wednesday 11 Nov 2026, 20:00 local time

function entry(id: number, title: string, playedAt: Date, extra: Partial<PlayHistoryEntry> = {}): PlayHistoryEntry {
  return { id, title, playedAt: playedAt.toISOString(), groupId: "g1", rooms: "Living Room", artist: "Artist", ...extra };
}

describe("history days", () => {
  it("says Today, Yesterday, the weekday, then the date", () => {
    expect(dayLabel(new Date(2026, 10, 11, 0, 5), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 10, 23, 59), NOW)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 6, 12), NOW)).toBe("Friday");
    expect(dayLabel(new Date(2026, 10, 3, 12), NOW)).toBe("Tue 3 Nov");
    expect(dayLabel(new Date(2025, 11, 31, 12), NOW)).toBe("Wed 31 Dec 2025");
  });

  it("groups the entries by day, keeping their order", () => {
    const days = byDay([
      entry(3, "C", new Date(2026, 10, 11, 19)),
      entry(2, "B", new Date(2026, 10, 11, 8)),
      entry(1, "A", new Date(2026, 10, 10, 22))
    ], NOW);
    expect(days.map((day) => [day.label, day.entries.map((e) => e.title)])).toEqual([["Today", ["C", "B"]], ["Yesterday", ["A"]]]);
  });

  it("puts a new song on top and takes out the one it replaced", () => {
    const list = [entry(2, "Skipped", NOW), entry(1, "Kept", NOW)];
    const change: PlayHistoryChange = { entry: entry(3, "New", NOW), replacedId: 2 };
    expect(applyChange(list, change).map((e) => e.title)).toEqual(["New", "Kept"]);
    // The same change twice doesn't list the song twice.
    expect(applyChange(applyChange(list, change), change).map((e) => e.title)).toEqual(["New", "Kept"]);
  });
});

describe("the History card", () => {
  let calls: { url: string; body?: string }[];

  beforeEach(() => {
    calls = [];
    const rows = [
      entry(2, "Radio song", new Date(Date.now() - 60_000), { rooms: "Office", artist: null, isLive: true }),
      entry(1, "Ripple", new Date(Date.now() - 120_000), { sourceId: "navidrome", trackId: "t9", album: "American Beauty" })
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/history?")) return json(rows);
      if (url.endsWith("/api/sources/navidrome/play")) return json({ groupId: "g1", state: "PLAYING", title: "Ripple", updatedAt: new Date().toISOString() });
      if (url.includes("/api/history/")) return new Response(null, { status: 204 });
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPanel(props: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
    const onPlayed = vi.fn();
    const view = render(
      <DialogProvider>
        <HistoryPanel groupId="g1" localMode={false} collapsed={false} onToggleCollapsed={() => {}} onPlayed={onPlayed} change={null} {...props} />
      </DialogProvider>
    );
    return { ...view, onPlayed };
  }

  it("lists the songs with their room, and plays one from a MiSonos source again", async () => {
    const { onPlayed } = renderPanel();
    const card = await screen.findByRole("region", { name: "History" });
    await within(card).findByText("Ripple");
    expect(within(card).getByText("Artist - American Beauty")).toBeTruthy();
    expect(within(card).getByText("Office")).toBeTruthy();
    expect(within(card).getByText("Radio")).toBeTruthy();
    // A song from another app can't be started from here; it can only be removed.
    expect(within(card).queryByRole("button", { name: "Play Radio song now" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Play Ripple now" }));
    await waitFor(() => expect(onPlayed).toHaveBeenCalled());
    const play = calls.find((call) => call.url.endsWith("/api/sources/navidrome/play"));
    expect(JSON.parse(play?.body ?? "{}")).toEqual({ trackIds: ["t9"], groupId: "g1", mode: "replace" });
  });

  it("shows a song as soon as the bridge writes it", async () => {
    const { rerender } = renderPanel();
    await screen.findByText("Ripple");
    const change: PlayHistoryChange = { entry: entry(3, "Sugar Magnolia", new Date(), { rooms: "Living Room + Office" }), replacedId: 2 };
    rerender(
      <DialogProvider>
        <HistoryPanel groupId="g1" localMode={false} collapsed={false} onToggleCollapsed={() => {}} onPlayed={() => {}} change={change} />
      </DialogProvider>
    );
    await screen.findByText("Sugar Magnolia");
    expect(screen.queryByText("Radio song")).toBeNull();
    const titles = screen.getAllByRole("listitem").map((item) => item.querySelector(".queue-meta > span")?.textContent);
    expect(titles).toEqual(["Sugar Magnolia", "Ripple"]);
  });

  it("removes a row from the history", async () => {
    renderPanel();
    await screen.findByText("Ripple");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Ripple from the history" })); });
    expect(screen.queryByText("Ripple")).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/api/history/1/delete"))).toBe(true);
  });

  it("loads nothing while it's folded away", () => {
    renderPanel({ collapsed: true });
    expect(calls.some((call) => call.url.includes("/api/history"))).toBe(false);
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-expanded")).toBe("false");
  });
});
