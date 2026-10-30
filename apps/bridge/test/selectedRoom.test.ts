import type { SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { describe, expect, it } from "vitest";
import { pickSelectedGroup, stepVolume } from "../src/selectedRoom.js";

const zone = (uuid: string, visible = true) => ({ id: uuid, uuid, name: uuid, ipAddress: "", location: "", visible }) as SonosZone;
const group = (id: string, zones: SonosZone[]) => ({ id, coordinatorId: zones[0].id, coordinatorName: zones[0].name, zones }) as SonosGroup;

describe("the room selected in MiSonos", () => {
  // Office alone; Living Room is a stereo pair whose right speaker is hidden.
  const office = group("RINCON_OFFICE:1", [zone("OFFICE")]);
  const living = group("RINCON_LIVING:7", [zone("LIVING"), zone("LIVING_R", false)]);
  const both = group("RINCON_OFFICE:9", [zone("OFFICE"), zone("LIVING"), zone("LIVING_R", false)]);

  it("finds the group by its visible rooms, whatever Sonos now calls it", () => {
    expect(pickSelectedGroup([office, living], "LIVING")?.id).toBe("RINCON_LIVING:7");
    expect(pickSelectedGroup([both], "LIVING|OFFICE")?.id).toBe("RINCON_OFFICE:9");
  });

  it("falls back to the group holding most of its rooms, then to the first group", () => {
    // Office and Living Room were grouped, and have since been split.
    expect(pickSelectedGroup([office, living], "LIVING|OFFICE")?.id).toBe("RINCON_OFFICE:1");
    expect(pickSelectedGroup([office, living], "KITCHEN")?.id).toBe("RINCON_OFFICE:1");
    expect(pickSelectedGroup([office, living], undefined)?.id).toBe("RINCON_OFFICE:1");
    expect(pickSelectedGroup([], "OFFICE")).toBeUndefined();
  });

  it("steps the volume within 0–100 and the app's cap", () => {
    expect(stepVolume(20, 2)).toBe(22);
    expect(stepVolume(1, -2)).toBe(0);
    expect(stepVolume(99, 2)).toBe(100);
    expect(stepVolume(39, 2, 40)).toBe(40);
    // Already above the cap: up does nothing, down still works.
    expect(stepVolume(50, 2, 40)).toBe(50);
    expect(stepVolume(50, -2, 40)).toBe(48);
  });
});
