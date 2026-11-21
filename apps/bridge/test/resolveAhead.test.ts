import type { NowPlaying, SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosService } from "../src/sonosService.js";

const { callSoap, discoverSsdp, fetchTrack } = vi.hoisted(() => ({ callSoap: vi.fn(), discoverSsdp: vi.fn(), fetchTrack: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));
vi.mock("../src/sonosSoap.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sonosSoap.js")>()), callSoap }));
vi.mock("../src/sources.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sources.js")>()), fetchTrack }));

const OFFICE: SonosZone = { id: "RINCON_A", uuid: "RINCON_A", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_A", groupId: "RINCON_A:1", visible: true, swGen: 2 };
const GROUP: SonosGroup = { id: "RINCON_A:1", coordinatorId: "RINCON_A", coordinatorName: "Office", zones: [OFFICE] };
const PLAYLIST = Array.from({ length: 12 }, (_, index) => ({ sourceId: "youtube-music", trackId: `t:video${String(index).padStart(6, "0")}` }));

function service(): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = service as unknown as { zones: Map<string, SonosZone>; groups: Map<string, SonosGroup>; lastDiscovery: number; nowPlaying: () => Promise<NowPlaying> };
  state.zones = new Map([[OFFICE.uuid, OFFICE]]);
  state.groups = new Map([[GROUP.id, GROUP]]);
  state.lastDiscovery = Date.now();
  state.nowPlaying = async () => ({ groupId: GROUP.id, state: "PLAYING", title: "", updatedAt: "" });
  return service;
}

/** Indexes (into PLAYLIST) of the tracks whose stream was looked up. */
function resolvedIndexes(): number[] {
  return fetchTrack.mock.calls
    .filter((call) => (call[2] as { stream?: boolean } | undefined)?.stream !== false)
    .map((call) => PLAYLIST.findIndex((ref) => ref.trackId === call[1]))
    .sort((a, b) => a - b);
}

describe("enqueuing a playlist looks up streams only for the tracks that play next", () => {
  beforeEach(() => {
    callSoap.mockReset();
    callSoap.mockImplementation(async (_ip: string, _service: string, action: string) => (action === "GetPositionInfo" ? { Track: "2" } : {}));
    fetchTrack.mockReset();
    fetchTrack.mockImplementation(async (_sourceId: string, id: string, options?: { stream?: boolean }) => ({
      id, title: `Song ${id}`, url: options?.stream === false ? "" : `https://googlevideo/${id}`, mimeType: "audio/mp4"
    }));
    process.env.MISONOS_BRIDGE_PUBLIC_HOST = "10.0.0.2";
  });
  afterEach(() => {
    delete process.env.MISONOS_BRIDGE_PUBLIC_HOST;
  });

  it("resolves the five from the start track on a replace, and only metadata for the rest", async () => {
    await service().playTrackRefs(PLAYLIST, GROUP.id, "replace", 4);
    expect(fetchTrack).toHaveBeenCalledTimes(12);
    expect(resolvedIndexes()).toEqual([3, 4, 5, 6, 7]);
    // Every track still goes on the queue, through the stream proxy.
    const adds = callSoap.mock.calls.filter((call) => call[2] === "AddURIToQueue").map((call) => (call[3] as { EnqueuedURI: string }).EnqueuedURI);
    expect(adds).toHaveLength(12);
    expect(adds.every((uri) => uri.startsWith("http://10.0.0.2:") && uri.includes("/api/stream/youtube-music/") && uri.endsWith(".m4a"))).toBe(true);
  });

  it("resolves the first five when adding to the queue", async () => {
    await service().playTrackRefs(PLAYLIST, GROUP.id, "next");
    expect(resolvedIndexes()).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the window inside the playlist when it starts near the end", async () => {
    await service().playTrackRefs(PLAYLIST, GROUP.id, "replace", 11);
    expect(resolvedIndexes()).toEqual([10, 11]);
  });

  it("still fails the enqueue when a track about to play can't be found", async () => {
    fetchTrack.mockImplementation(async (_sourceId: string, id: string, options?: { stream?: boolean }) => {
      if (id === PLAYLIST[1].trackId && options?.stream !== false) throw new Error("Video unavailable");
      return { id, title: `Song ${id}`, url: "", mimeType: "audio/mp4" };
    });
    await expect(service().playTrackRefs(PLAYLIST, GROUP.id, "replace")).rejects.toThrow("Video unavailable");
    expect(callSoap.mock.calls.map((call) => call[2])).not.toContain("AddURIToQueue");
  });
});
