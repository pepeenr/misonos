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
const QUEUE_URI = "x-rincon-queue:RINCON_A#0";
const RADIO = [{ sourceId: "navidrome", trackId: "r1" }, { sourceId: "navidrome", trackId: "r2" }];

function service(): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = service as unknown as { zones: Map<string, SonosZone>; groups: Map<string, SonosGroup>; lastDiscovery: number; nowPlaying: () => Promise<NowPlaying> };
  state.zones = new Map([[OFFICE.uuid, OFFICE]]);
  state.groups = new Map([[GROUP.id, GROUP]]);
  state.lastDiscovery = Date.now();
  state.nowPlaying = async () => ({ groupId: GROUP.id, state: "PLAYING", title: "", updatedAt: "" });
  return service;
}

/** A coordinator playing `currentUri`, on track `track` of `tracks`. */
function speaker(currentUri: string, track: number, tracks: number) {
  callSoap.mockImplementation(async (_ip: string, _service: string, action: string) => {
    if (action === "GetMediaInfo") return { CurrentURI: currentUri, NrTracks: String(tracks) };
    if (action === "GetPositionInfo") return { Track: String(track) };
    return {};
  });
}

const actions = () => callSoap.mock.calls.map((call) => call[2] as string);
const callOf = (action: string) => callSoap.mock.calls.find((call) => call[2] === action)?.[3];

describe("a song radio after the song playing now", () => {
  beforeEach(() => {
    callSoap.mockReset();
    fetchTrack.mockReset();
    fetchTrack.mockImplementation(async (_sourceId: string, id: string) => ({ id, title: `Song ${id}`, url: `http://navidrome/${id}`, mimeType: "audio/mpeg" }));
    process.env.MISONOS_BRIDGE_PUBLIC_HOST = "10.0.0.2";
  });
  afterEach(() => {
    delete process.env.MISONOS_BRIDGE_PUBLIC_HOST;
  });

  it("knows where the room is in its queue, and only while it plays the queue", async () => {
    speaker(QUEUE_URI, 3, 10);
    await expect(service().queuePosition(GROUP.id)).resolves.toEqual({ track: 3, tracks: 10 });
    speaker("x-sonos-vli:RINCON_A:1,spotify:abc", 1, 0);
    await expect(service().queuePosition(GROUP.id)).resolves.toBeUndefined();
  });

  it("removes the songs after the one playing and adds the radio there, without stopping it", async () => {
    speaker(QUEUE_URI, 3, 10);
    const sonos = service();
    const onEnqueue = vi.fn();
    sonos.onEnqueue = onEnqueue;
    await sonos.replaceUpcoming(GROUP.id, RADIO);
    expect(callOf("RemoveTrackRangeFromQueue")).toMatchObject({ StartingIndex: 4, NumberOfTracks: 7 });
    const adds = callSoap.mock.calls.filter((call) => call[2] === "AddURIToQueue").map((call) => call[3] as { EnqueuedURI: string; DesiredFirstTrackNumberEnqueued: number });
    expect(adds.map((add) => add.EnqueuedURI)).toEqual([
      expect.stringContaining("/api/stream/navidrome/r1/"),
      expect.stringContaining("/api/stream/navidrome/r2/")
    ]);
    expect(adds.every((add) => add.DesiredFirstTrackNumberEnqueued === 0)).toBe(true);
    expect(actions()).not.toContain("RemoveAllTracksFromQueue");
    expect(actions()).not.toContain("Play");
    expect(actions()).not.toContain("SetAVTransportURI");
    expect(onEnqueue).toHaveBeenCalledWith({ groupId: GROUP.id, mode: "end" });
  });

  it("removes nothing when the song playing is the last one", async () => {
    speaker(QUEUE_URI, 10, 10);
    await service().replaceUpcoming(GROUP.id, RADIO);
    expect(actions()).not.toContain("RemoveTrackRangeFromQueue");
    expect(actions().filter((action) => action === "AddURIToQueue")).toHaveLength(2);
  });

  it("leaves the queue alone when a song can't be looked up", async () => {
    speaker(QUEUE_URI, 3, 10);
    fetchTrack.mockRejectedValueOnce(new Error("Navidrome is down"));
    await expect(service().replaceUpcoming(GROUP.id, RADIO)).rejects.toThrow("Navidrome is down");
    expect(actions()).not.toContain("RemoveTrackRangeFromQueue");
    expect(actions()).not.toContain("AddURIToQueue");
  });

  it("replaces the whole queue when the room isn't playing it", async () => {
    speaker("x-sonos-vli:RINCON_A:1,spotify:abc", 1, 0);
    await service().replaceUpcoming(GROUP.id, RADIO);
    expect(actions()).toContain("RemoveAllTracksFromQueue");
    expect(callOf("SetAVTransportURI")).toMatchObject({ CurrentURI: QUEUE_URI });
    expect(actions()).toContain("Play");
  });
});
