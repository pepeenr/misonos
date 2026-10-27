import { describe, expect, it } from "vitest";
import type { SonosGroup } from "@misonos/sonos-protocol";
import { assignGroupPalettes, buildGroupOptions } from "./groupPalette.js";
import { GROUP_COLORS_PREF } from "./prefs.js";

const group = (coordinatorId: string): SonosGroup => ({
  id: `group-${coordinatorId}`,
  coordinatorId,
  coordinatorName: coordinatorId,
  zones: [{ id: coordinatorId, uuid: coordinatorId, name: `Room ${coordinatorId}`, ipAddress: "10.0.0.2", location: "", visible: true }]
} as SonosGroup);

describe("assignGroupPalettes", () => {
  const groups = [group("RINCON_A"), group("RINCON_B"), group("RINCON_C")];

  it("gives a picked color to its group, and moves an automatic group off it", () => {
    const automatic = assignGroupPalettes(groups);
    const takenByB = automatic.get("RINCON_B")!.name;
    const picked = assignGroupPalettes(groups, { RINCON_A: takenByB });
    expect(picked.get("RINCON_A")!.name).toBe(takenByB);
    expect(picked.get("RINCON_B")!.name).not.toBe(takenByB);
    expect(new Set([...picked.values()].map((entry) => entry.name)).size).toBe(3);
  });

  it("keeps two groups on the same color when both picked it", () => {
    const picked = assignGroupPalettes(groups, { RINCON_A: "Coral", RINCON_B: "Coral" });
    expect(picked.get("RINCON_A")!.name).toBe("Coral");
    expect(picked.get("RINCON_B")!.name).toBe("Coral");
  });

  it("ignores a name that isn't in the palette", () => {
    expect(assignGroupPalettes(groups, { RINCON_A: "Plaid" })).toEqual(assignGroupPalettes(groups));
  });

  it("names the group options after the picked color", () => {
    expect(buildGroupOptions([group("RINCON_A")], { RINCON_A: "Lilac" })[0]).toMatchObject({ name: "Lilac", color: "#c2a5ff" });
  });
});

describe("GROUP_COLORS_PREF", () => {
  it("reads back what it writes, and drops anything that isn't a name", () => {
    expect(GROUP_COLORS_PREF.decode(GROUP_COLORS_PREF.encode({ RINCON_A: "Amber" }))).toEqual({ RINCON_A: "Amber" });
    expect(GROUP_COLORS_PREF.decode('{"RINCON_A":"Amber","RINCON_B":3}')).toEqual({ RINCON_A: "Amber" });
    expect(GROUP_COLORS_PREF.decode("[]")).toBeNull();
    expect(GROUP_COLORS_PREF.decode("not json")).toBeNull();
  });
});
