import type { SonosZone } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosService } from "../src/sonosService.js";
import { parseZoneGroupState } from "../src/topology.js";

const { callSoap, discoverSsdp } = vi.hoisted(() => ({ callSoap: vi.fn(), discoverSsdp: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));
vi.mock("../src/sonosSoap.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sonosSoap.js")>()), callSoap }));

const LIVING: SonosZone = { id: "RINCON_L", uuid: "RINCON_L", name: "Living Room", ipAddress: "10.0.0.24", location: "", coordinatorId: "RINCON_L", groupId: "RINCON_L:1", visible: true, hasSub: true };
const OFFICE: SonosZone = { id: "RINCON_O", uuid: "RINCON_O", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_O", groupId: "RINCON_O:1", visible: true };

function service(): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = service as unknown as { zones: Map<string, SonosZone>; groups: Map<string, unknown>; lastDiscovery: number };
  state.zones = new Map([LIVING, OFFICE].map((zone) => [zone.uuid, zone]));
  state.groups = new Map();
  state.lastDiscovery = Date.now();
  return service;
}

/** A speaker holding a Sub level of `subGain`; SetEQ changes it. */
function speaker(subGain: number) {
  callSoap.mockImplementation(async (_ip: string, _service: string, action: string, args: Record<string, unknown>) => {
    if (action === "SetEQ") subGain = Number(args.DesiredValue);
    if (action === "GetBass") return { CurrentBass: "0" };
    if (action === "GetTreble") return { CurrentTreble: "0" };
    if (action === "GetLoudness") return { CurrentLoudness: "0" };
    if (action === "GetEQ") return { CurrentValue: String(subGain) };
    return {};
  });
}

describe("a room's Sub level", () => {
  beforeEach(() => {
    callSoap.mockReset();
    discoverSsdp.mockReset();
  });

  it("is read and set for a room that has a Sub, and kept within -15..15", async () => {
    speaker(-3);
    expect((await service().zoneEq(LIVING.id)).subGain).toBe(-3);

    const eq = await service().setZoneEq(LIVING.id, { subGain: 40 });
    expect(callSoap).toHaveBeenCalledWith("10.0.0.24", "RenderingControl", "SetEQ", { InstanceID: 0, EQType: "SubGain", DesiredValue: 15 });
    expect(eq.subGain).toBe(15);
  });

  it("is left out of a room without a Sub, and can't be set there", async () => {
    speaker(0);
    expect(await service().zoneEq(OFFICE.id)).not.toHaveProperty("subGain");
    expect(callSoap.mock.calls.map((call) => call[2])).not.toContain("GetEQ");

    await expect(service().setZoneEq(OFFICE.id, { subGain: 2 })).rejects.toThrow("Office has no Sub");
    expect(callSoap.mock.calls.map((call) => call[2])).not.toContain("SetEQ");
  });

  it("only changes the Sub when asked, not bass or treble", async () => {
    speaker(0);
    await service().setZoneEq(LIVING.id, { subGain: 2 });
    expect(callSoap.mock.calls.map((call) => call[2])).not.toContain("SetBass");
    expect(callSoap.mock.calls.map((call) => call[2])).not.toContain("SetTreble");
  });
});

describe("which rooms have a Sub", () => {
  it("is marked on the visible member of a stereo pair with a Sub, and of a home theater with one", () => {
    const map = "RINCON_L:LF,LF;RINCON_R:RF,RF;RINCON_SUB:SW";
    const pair = `<ZoneGroups><ZoneGroup Coordinator="RINCON_L" ID="RINCON_L:1"><ZoneGroupMember UUID="RINCON_L" Location="http://10.0.0.4:1400/xml/device_description.xml" ZoneName="Living Room" ChannelMapSet="${map}"/><ZoneGroupMember UUID="RINCON_R" Location="http://10.0.0.3:1400/xml/device_description.xml" ZoneName="Living Room" Invisible="1" ChannelMapSet="${map}"/><ZoneGroupMember UUID="RINCON_SUB" Location="http://10.0.0.5:1400/xml/device_description.xml" ZoneName="Sub" Invisible="1" ChannelMapSet="${map}"/></ZoneGroup></ZoneGroups>`;
    expect(Object.fromEntries(parseZoneGroupState(pair).zones.map((zone) => [zone.uuid, zone.hasSub]))).toEqual({ RINCON_L: true, RINCON_R: undefined, RINCON_SUB: undefined });

    const theater = `<ZoneGroups><ZoneGroup Coordinator="RINCON_ARC" ID="RINCON_ARC:1"><ZoneGroupMember UUID="RINCON_ARC" Location="http://10.0.0.2:1400/xml/device_description.xml" ZoneName="TV Room" HTSatChanMapSet="RINCON_ARC:LF,RF;RINCON_SUB:SW;RINCON_SL:LR"><Satellite UUID="RINCON_SL" Location="http://10.0.0.5:1400/xml/device_description.xml" ZoneName="TV Room" Invisible="1"/></ZoneGroupMember></ZoneGroup></ZoneGroups>`;
    expect(parseZoneGroupState(theater).zones.find((zone) => zone.uuid === "RINCON_ARC")?.hasSub).toBe(true);
  });

  it("isn't marked on a stereo pair without one, or on a lone speaker", () => {
    const map = "RINCON_L:LF,LF;RINCON_R:RF,RF";
    const pair = `<ZoneGroups><ZoneGroup Coordinator="RINCON_L" ID="RINCON_L:1"><ZoneGroupMember UUID="RINCON_L" Location="http://10.0.0.4:1400/xml/device_description.xml" ZoneName="Den" ChannelMapSet="${map}"/><ZoneGroupMember UUID="RINCON_R" Location="http://10.0.0.3:1400/xml/device_description.xml" ZoneName="Den" Invisible="1" ChannelMapSet="${map}"/><ZoneGroupMember UUID="RINCON_O" Location="http://10.0.0.2:1400/xml/device_description.xml" ZoneName="Office"/></ZoneGroup></ZoneGroups>`;
    expect(parseZoneGroupState(pair).zones.some((zone) => zone.hasSub)).toBe(false);
  });
});
