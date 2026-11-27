import { describe, expect, it } from "vitest";
import { actionError } from "./actionError.js";
import { sameQueue } from "./queueRows.js";

describe("actionError", () => {
  it("passes on the bridge's words when they're meant for people", () => {
    expect(actionError(new Error("That Spotify login isn't linked in the Sonos app"), "Couldn't switch")).toBe("That Spotify login isn't linked in the Sonos app");
  });

  it("says what failed instead of a speaker's fault code, a bare status or a dropped connection", () => {
    expect(actionError(new Error("UPnPError (code=711)"), "Couldn't skip to the next song")).toBe("Couldn't skip to the next song");
    expect(actionError(new Error("Sonos SOAP Next failed (code=?)"), "Couldn't skip")).toBe("Couldn't skip");
    expect(actionError(new Error("Request failed: 500"), "Couldn't pause")).toBe("Couldn't pause");
    expect(actionError(new TypeError("Failed to fetch"), "Couldn't pause")).toBe("Couldn't pause");
    expect(actionError("nope", "Couldn't pause")).toBe("Couldn't pause");
  });
});

describe("sameQueue", () => {
  const rows = [{ id: "Q:0/1", title: "One", uri: "http://x/1" }, { id: "Q:0/2", title: "Two", uri: "http://x/2" }];

  it("is the same queue when every row shows the same", () => {
    expect(sameQueue(rows, rows.map((row) => ({ ...row })))).toBe(true);
  });

  it("differs when a row was added, moved or got its title", () => {
    expect(sameQueue(rows, rows.slice(0, 1))).toBe(false);
    expect(sameQueue(rows, [...rows].reverse())).toBe(false);
    expect(sameQueue(rows, [rows[0], { ...rows[1], title: "Two (Live)" }])).toBe(false);
  });
});
