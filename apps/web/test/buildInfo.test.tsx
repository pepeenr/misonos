import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppVersion } from "../src/AppVersion.js";
import { BUILD, formatBuild, sameBuild } from "../src/buildInfo.js";

describe("the app version", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the build time and, when known, the commit", () => {
    expect(formatBuild({ time: "2026-11-18T18:20:00.000Z", commit: "3d51984" }, "en-GB")).toMatch(/^18 Nov 2026, \d\d:20 · 3d51984$/);
    expect(formatBuild({ time: "2026-11-18T18:20:00.000Z" }, "en-GB")).toMatch(/^18 Nov 2026, \d\d:20$/);
  });

  it("tells builds apart by time and commit", () => {
    expect(sameBuild({ time: "a", commit: "1" }, { time: "a", commit: "1" })).toBe(true);
    expect(sameBuild({ time: "a" }, { time: "b" })).toBe(false);
    expect(sameBuild({ time: "a", commit: "1" }, { time: "a", commit: "2" })).toBe(false);
  });

  it("says when this is the server's newest build", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(BUILD))));
    render(<AppVersion />);
    expect(await screen.findByText(/latest/)).toBeInTheDocument();
  });

  it("offers a reload when the server has a newer build", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ time: "2099-01-01T00:00:00.000Z" }))));
    render(<AppVersion />);
    expect(await screen.findByRole("button", { name: /newer version available/ })).toBeInTheDocument();
  });

  it("shows just the version when the server can't say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { status: 200 })));
    render(<AppVersion />);
    expect(screen.getByText(/^MiSonos /)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/latest/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
