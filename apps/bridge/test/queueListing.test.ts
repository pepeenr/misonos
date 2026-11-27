import type { SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosService } from "../src/sonosService.js";

const { callSoap, discoverSsdp } = vi.hoisted(() => ({ callSoap: vi.fn(), discoverSsdp: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));
vi.mock("../src/sonosSoap.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sonosSoap.js")>()), callSoap }));

const OFFICE: SonosZone = { id: "RINCON_A", uuid: "RINCON_A", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_A", groupId: "RINCON_A:1", visible: true, swGen: 2 };
const KITCHEN: SonosZone = { id: "RINCON_B", uuid: "RINCON_B", name: "Kitchen", ipAddress: "10.0.0.36", location: "", coordinatorId: "RINCON_B", groupId: "RINCON_B:1", visible: true, swGen: 2 };
const GROUP: SonosGroup = { id: "RINCON_A:1", coordinatorId: "RINCON_A", coordinatorName: "Office", zones: [OFFICE] };

function service(): SonosService {
  const sonos = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = sonos as unknown as { zones: Map<string, SonosZone>; groups: Map<string, SonosGroup>; lastDiscovery: number };
  state.zones = new Map([[OFFICE.uuid, OFFICE]]);
  state.groups = new Map([[GROUP.id, GROUP]]);
  state.lastDiscovery = Date.now();
  return sonos;
}

// A queue of `total` Navidrome songs, as the speaker lists it, 100 a page.
function speakerQueue(total: number, updateId: () => string) {
  callSoap.mockImplementation(async (_ip: string, _service: string, action: string, args: { StartingIndex: number; RequestedCount: number }) => {
    if (action !== "Browse") return {};
    const end = Math.min(total, args.StartingIndex + Math.min(args.RequestedCount, 100));
    let didl = "";
    for (let n = args.StartingIndex + 1; n <= end; n += 1) {
      didl += `<item id="Q:0/${n}"><dc:title>Song ${n}</dc:title><res>http://10.0.0.2:4317/api/stream/navidrome/t${n}/Song%20${n}.mp3</res></item>`;
    }
    return { Result: `<DIDL-Lite>${didl}</DIDL-Lite>`, NumberReturned: String(end - args.StartingIndex), TotalMatches: String(total), UpdateID: updateId() };
  });
}

const pagesAsked = () => callSoap.mock.calls.filter((call) => call[2] === "Browse").map((call) => (call[3] as { StartingIndex: number }).StartingIndex);

describe("the queue", () => {
  beforeEach(() => {
    callSoap.mockReset();
  });

  it("lists every track of a queue longer than one page, up to its last", async () => {
    speakerQueue(250, () => "7");
    const queue = await service().queue(GROUP.id);
    expect(queue).toHaveLength(250);
    expect(queue[249]).toMatchObject({ title: "Song 250", sourceId: "navidrome", trackId: "t250" });
    expect(pagesAsked()).toEqual([0, 100, 200]);
  });

  it("reads only the first page again while the queue hasn't changed", async () => {
    let updateId = "7";
    speakerQueue(250, () => updateId);
    const sonos = service();
    await sonos.queue(GROUP.id);
    callSoap.mockClear();
    expect(await sonos.queue(GROUP.id)).toHaveLength(250);
    expect(pagesAsked()).toEqual([0]);

    // An edit on the speaker (here or in the Sonos app) bumps its UpdateID.
    updateId = "8";
    callSoap.mockClear();
    await sonos.queue(GROUP.id);
    expect(pagesAsked()).toEqual([0, 100, 200]);
  });

  it("asks once for a queue that fits on a page", async () => {
    speakerQueue(89, () => "1384");
    expect(await service().queue(GROUP.id)).toHaveLength(89);
    expect(pagesAsked()).toEqual([0]);
  });

  it("saves every track of a long queue as a playlist", async () => {
    speakerQueue(150, () => "3");
    const { items, skipped } = await service().queueTrackRefs(GROUP.id);
    expect(items).toHaveLength(150);
    expect(items[149]).toMatchObject({ sourceId: "navidrome", trackId: "t150" });
    expect(skipped).toBe(0);
  });
});

describe("the household's layout", () => {
  beforeEach(() => {
    callSoap.mockReset();
  });

  it("asks the next speaker when the first can't answer, rather than splitting every group", async () => {
    const state = `<ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.35:1400/xml/device_description.xml" ZoneName="Office"/><ZoneGroupMember UUID="RINCON_B" Location="http://10.0.0.36:1400/xml/device_description.xml" ZoneName="Kitchen"/></ZoneGroup></ZoneGroups>`;
    callSoap.mockImplementation(async (ip: string, _service: string, action: string) => {
      if (action !== "GetZoneGroupState") return {};
      if (ip === OFFICE.ipAddress) throw new Error("connect EHOSTUNREACH 10.0.0.35:1400");
      return { ZoneGroupState: state };
    });
    const sonos = service();
    await (sonos as unknown as { refreshTopology: (seeds: SonosZone[]) => Promise<void> }).refreshTopology([OFFICE, KITCHEN]);
    const snapshot = await sonos.cachedSnapshot();
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].zones.map((zone) => zone.name).sort()).toEqual(["Kitchen", "Office"]);
  });

  it("falls back to a group per room only when no speaker answers", async () => {
    callSoap.mockRejectedValue(new Error("connect EHOSTUNREACH"));
    const sonos = service();
    await (sonos as unknown as { refreshTopology: (seeds: SonosZone[]) => Promise<void> }).refreshTopology([OFFICE, KITCHEN]);
    expect((await sonos.cachedSnapshot()).groups.map((group) => group.id)).toEqual([OFFICE.uuid]);
  });
});
