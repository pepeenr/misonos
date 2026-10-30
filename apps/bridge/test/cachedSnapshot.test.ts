import type { SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosService } from "../src/sonosService.js";

const { discoverSsdp } = vi.hoisted(() => ({ discoverSsdp: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));

const OFFICE: SonosZone = { id: "RINCON_A", uuid: "RINCON_A", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_A", groupId: "RINCON_A:1", visible: true };
const GROUP: SonosGroup = { id: "RINCON_A:1", coordinatorId: "RINCON_A", coordinatorName: "Office", zones: [OFFICE] };

interface ServiceState {
  zones: Map<string, SonosZone>;
  groups: Map<string, SonosGroup>;
  lastDiscovery: number;
}

function serviceWith(rooms: { lastDiscovery: number } | null): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  if (rooms) {
    const state = service as unknown as ServiceState;
    state.zones = new Map([[OFFICE.uuid, OFFICE]]);
    state.groups = new Map([[GROUP.id, GROUP]]);
    state.lastDiscovery = rooms.lastDiscovery;
  }
  return service;
}

describe("cachedSnapshot", () => {
  beforeEach(() => {
    discoverSsdp.mockReset();
  });

  it("answers from the rooms already known while a stale view refreshes in the background", async () => {
    let finishSweep: (devices: unknown[]) => void = () => undefined;
    discoverSsdp.mockReturnValue(new Promise((resolve) => { finishSweep = resolve; }));
    const service = serviceWith({ lastDiscovery: Date.now() - 60_000 });

    // The sweep is still running, so waiting for it would never get here.
    const snapshot = await service.cachedSnapshot();
    expect(snapshot.groups.map((group) => group.id)).toEqual([GROUP.id]);
    expect(discoverSsdp).toHaveBeenCalledTimes(1);

    // A second call while that sweep runs doesn't start another.
    await service.cachedSnapshot();
    expect(discoverSsdp).toHaveBeenCalledTimes(1);
    finishSweep([]);
  });

  it("skips the sweep while the view is fresh", async () => {
    const service = serviceWith({ lastDiscovery: Date.now() - 5_000 });
    expect((await service.cachedSnapshot()).groups).toHaveLength(1);
    expect(discoverSsdp).not.toHaveBeenCalled();
  });

  it("waits for discovery when no rooms are known yet", async () => {
    discoverSsdp.mockResolvedValue([]);
    const service = serviceWith(null);
    expect((await service.cachedSnapshot()).groups).toEqual([]);
    expect(discoverSsdp).toHaveBeenCalledTimes(1);
  });
});
