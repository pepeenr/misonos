import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "https://misonos.example.org";

// Access's answer to a fetch without a session: 401 when marked as XHR, else a redirect.
const accessDenied = () => new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Cloudflare-Access resource_metadata="x"' } });
const accessRedirect = () => ({ type: "opaqueredirect", status: 0, headers: new Headers() }) as Response;

// Fresh module state (signed-out flag, check throttle) for every test.
async function load() {
  vi.resetModules();
  const session = await import("./accessSession.js");
  const { bridgeApi } = await import("./api.js");
  return { ...session, bridgeApi };
}

describe("Cloudflare Access sign-in", () => {
  let assign: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // jsdom can't navigate, so swap window.location for a stub that records it.
    originalLocation = window.location;
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: HOME, hostname: new URL(HOME).hostname, href: `${HOME}/`, assign }
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("tells Access's 401 and login redirect apart from the bridge's own answers", async () => {
    const { accessSessionExpired } = await load();
    const answers = [accessDenied(), accessRedirect(), new Response("{}", { status: 200 }), new Response(null, { status: 401 })];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    expect(await accessSessionExpired()).toBe(true);
    expect(await accessSessionExpired()).toBe(true);
    expect(await accessSessionExpired()).toBe(false);
    expect(await accessSessionExpired()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.objectContaining({ redirect: "manual", cache: "no-store" }));
  });

  it("sends the window through the login when a bridge call fails because the session expired", async () => {
    const { bridgeApi } = await load();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/health") return accessDenied();
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(bridgeApi.zones()).rejects.toThrow(TypeError);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/?signin"));
    expect(Number(sessionStorage.getItem("misonos:accessSignInAt"))).toBeGreaterThan(0);
    // More failures right after don't check again.
    await expect(bridgeApi.groups()).rejects.toThrow(TypeError);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/health")).toHaveLength(1);
  });

  it("shows the banner instead of going back to the login right after a sign-in", async () => {
    sessionStorage.setItem("misonos:accessSignInAt", String(Date.now() - 10_000));
    const { noteBridgeFailure, useAccessSignedOut } = await load();
    vi.stubGlobal("fetch", vi.fn(async () => accessRedirect()));
    const { result } = renderHook(() => useAccessSignedOut());
    expect(result.current).toBe(false);
    noteBridgeFailure();
    await waitFor(() => expect(result.current).toBe(true));
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves a plain network failure and a switched-to backend alone", async () => {
    const { noteBridgeFailure, useAccessSignedOut } = await load();
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAccessSignedOut());
    noteBridgeFailure();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
    expect(assign).not.toHaveBeenCalled();

    const again = await load();
    localStorage.setItem("misonos.apiBase", "https://other-host.example.org");
    again.noteBridgeFailure();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the ?signin marker the login returns to", async () => {
    const { clearSignInMarker } = await load();
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    window.location.href = `${HOME}/?signin#queue`;
    clearSignInMarker();
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", "/#queue");
    replaceState.mockRestore();
  });
});
