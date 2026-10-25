import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/store/index.js";
import { isKnownSource, listSourceSettings, listSources, readDisabledSources, setSourceEnabled } from "../src/sources.js";

// Every source answers /info except Navidrome, which (like an unconfigured
// Navidrome) returns 503. /info hits are recorded to prove disabled sources
// aren't probed at all.
function stubSources(): string[] {
  const probed: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    const port = url.port;
    probed.push(port);
    if (port === "4325") return new Response("not configured", { status: 503 });
    return new Response(JSON.stringify({ id: `src-${port}`, name: `Source ${port}`, rootId: "root" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  return probed;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("source toggles", () => {
  it("persists disabled sources and re-enables them", async () => {
    const store = await createStore(":memory:");
    try {
      expect(await readDisabledSources(store)).toEqual(new Set());
      await setSourceEnabled(store, "phish-in", false);
      await setSourceEnabled(store, "grateful-dead-archive", false);
      expect(await readDisabledSources(store)).toEqual(new Set(["phish-in", "grateful-dead-archive"]));
      await setSourceEnabled(store, "phish-in", true);
      expect(await readDisabledSources(store)).toEqual(new Set(["grateful-dead-archive"]));
    } finally {
      await store.close();
    }
  });

  it("ignores a malformed stored value", async () => {
    const store = await createStore(":memory:");
    try {
      await store.setPreference("disabledSources", "phish-in");
      expect(await readDisabledSources(store)).toEqual(new Set());
      await store.setPreference("disabledSources", ["tunein", 7, null]);
      expect(await readDisabledSources(store)).toEqual(new Set(["tunein"]));
    } finally {
      await store.close();
    }
  });

  it("knows only the configured source ids", () => {
    expect(isKnownSource("navidrome")).toBe(true);
    expect(isKnownSource("spotify")).toBe(false);
  });

  it("leaves disabled sources out of the list without probing them", async () => {
    const probed = stubSources();
    const sources = await listSources(new Set(["grateful-dead-archive", "phish-in"]));
    expect(probed).not.toContain("4319");
    expect(probed).not.toContain("4320");
    expect(sources.map((source) => source.name)).toEqual(["Source 4321", "Source 4322", "Source 4323", "Source 4324"]);
  });

  it("lists every source in settings, with a fallback name when it isn't answering", async () => {
    stubSources();
    const settings = await listSourceSettings(new Set(["phish-in"]));
    expect(settings.map((source) => source.id)).toEqual([
      "grateful-dead-archive", "phish-in", "youtube-music", "live-music-archive", "podcasts", "tunein", "navidrome"
    ]);
    expect(settings.find((source) => source.id === "phish-in")).toMatchObject({ enabled: false, available: true, name: "Source 4320" });
    expect(settings.find((source) => source.id === "navidrome")).toEqual({ id: "navidrome", name: "Navidrome", enabled: true, available: false });
  });
});
