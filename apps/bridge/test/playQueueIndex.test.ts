import type { NowPlaying, SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosSoapError } from "../src/sonosSoap.js";
import { SonosService } from "../src/sonosService.js";

const { callSoap, discoverSsdp } = vi.hoisted(() => ({ callSoap: vi.fn(), discoverSsdp: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));
vi.mock("../src/sonosSoap.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sonosSoap.js")>()), callSoap }));

const OFFICE: SonosZone = { id: "RINCON_A", uuid: "RINCON_A", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_A", groupId: "RINCON_A:1", visible: true };
const GROUP: SonosGroup = { id: "RINCON_A:1", coordinatorId: "RINCON_A", coordinatorName: "Office", zones: [OFFICE] };
const QUEUE_URI = "x-rincon-queue:RINCON_A#0";

function service(): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = service as unknown as { zones: Map<string, SonosZone>; groups: Map<string, SonosGroup>; lastDiscovery: number; nowPlayingSettled: () => Promise<NowPlaying> };
  state.zones = new Map([[OFFICE.uuid, OFFICE]]);
  state.groups = new Map([[GROUP.id, GROUP]]);
  state.lastDiscovery = Date.now();
  state.nowPlayingSettled = async () => ({ groupId: GROUP.id, state: "PLAYING", updatedAt: "" }) as NowPlaying;
  return service;
}

/** Answers like a coordinator whose transport plays `currentUri`; a track seek only works on the queue. */
function speaker(currentUri: string, trackCount = 5) {
  callSoap.mockImplementation(async (_ip: string, _service: string, action: string, args: Record<string, unknown>) => {
    if (action === "GetMediaInfo") return { CurrentURI: currentUri };
    if (action === "SetAVTransportURI") currentUri = String(args.CurrentURI);
    if (action === "Seek" && (currentUri !== QUEUE_URI || Number(args.Target) > trackCount)) {
      throw new SonosSoapError("Transition not available (code=701)", 500, "701");
    }
    return {};
  });
}

const actions = () => callSoap.mock.calls.map((call) => call[2] as string);

describe("playQueueIndex", () => {
  beforeEach(() => {
    callSoap.mockReset();
    discoverSsdp.mockReset();
  });

  it("seeks to the track and plays, while the queue is what's playing", async () => {
    speaker(QUEUE_URI);
    await service().playQueueIndex(GROUP.id, 3);
    expect(actions()).toEqual(["Seek", "Play"]);
    expect(callSoap.mock.calls[0][3]).toMatchObject({ Unit: "TRACK_NR", Target: 3 });
  });

  it("goes back to the queue first when something else is playing, so the queue carries on from that track", async () => {
    speaker("x-sonosapi-stream:s12345?sid=254&flags=8224&sn=0");
    await service().playQueueIndex(GROUP.id, 3);
    expect(actions()).toEqual(["Seek", "GetMediaInfo", "SetAVTransportURI", "Seek", "Play"]);
    expect(callSoap.mock.calls[2][3]).toMatchObject({ CurrentURI: QUEUE_URI });
    expect(callSoap.mock.calls[3][3]).toMatchObject({ Unit: "TRACK_NR", Target: 3 });
  });

  it("leaves the queue alone when the seek itself is bad", async () => {
    speaker(QUEUE_URI, 2);
    await expect(service().playQueueIndex(GROUP.id, 9)).rejects.toBeInstanceOf(SonosSoapError);
    expect(actions()).toEqual(["Seek", "GetMediaInfo"]);
  });
});
