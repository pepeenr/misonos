import { writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, redirectUri } from "../src/config.js";
import { createServer } from "../src/server.js";

const REDIRECT = "https://misonos.example/api/sources/spotify/auth/callback";

// Spotify itself: the token endpoint and the Web API.
const fakeSpotify = (async (input: URL | RequestInfo) => {
  const url = new URL(String(input));
  if (url.host === "accounts.spotify.com") {
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  }
  if (url.pathname === "/v1/me") return Response.json({ id: "user-1", display_name: "User One" });
  if (url.pathname === "/v1/tracks/t1") return Response.json({ id: "t1", name: "One", type: "track", artists: [] });
  return Response.json({ error: { status: 404, message: "Not found" } }, { status: 404 });
}) as typeof fetch;

describe("spotify-smapi server", () => {
  let dir: string;
  let server: http.Server;
  let base: string;

  async function start(env: Record<string, string>): Promise<void> {
    server = createServer(loadConfig({ MISONOS_SPOTIFY_TOKEN_PATH: path.join(dir, "token.json"), ...env }), fakeSpotify);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const get = async (pathname: string) => {
    const response = await fetch(`${base}${pathname}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "spotify-server-"));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("stays out of the source list until a client id is set, but explains itself", async () => {
    await start({});
    expect((await get("/info")).status).toBe(503);
    expect(await get("/auth/status")).toEqual({ status: 200, body: { configured: false, signedIn: false } });
  });

  it("shows a sign-in notice at the root while signed out", async () => {
    await start({ MISONOS_SPOTIFY_CLIENT_ID: "client-1" });
    const info = await get("/info");
    expect(info.body).toMatchObject({ id: "spotify", rootId: "root", capabilities: ["search", "sonos-only"] });
    expect((await get("/browse?id=root")).body.items).toEqual([
      expect.objectContaining({ kind: "section", title: expect.stringMatching(/Connect Spotify/) })
    ]);
    expect((await get("/browse?id=me:playlists")).status).toBe(401);
    expect((await get("/auth/status")).body).toEqual({ configured: true, signedIn: false, redirectUri: null });
  });

  it("signs in through login and callback, then serves the library", async () => {
    await start({ MISONOS_SPOTIFY_CLIENT_ID: "client-1" });
    const login = await get(`/auth/login?redirect_uri=${encodeURIComponent(REDIRECT)}`);
    const authorize = new URL(String(login.body.url));
    expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT);

    const callback = await get(`/auth/callback?code=c&state=${authorize.searchParams.get("state")}`);
    expect(callback.body).toEqual({ signedIn: true, user: { id: "user-1", displayName: "User One" } });
    expect((await get("/browse?id=root")).body.items).toHaveLength(6);
    expect((await get("/track?id=spotify:track:t1")).body).toMatchObject({ title: "One", url: "spotify:track:t1" });
    expect((await get("/track?id=spotify:track:missing")).status).toBe(404);
    expect((await get("/browse?id=album:a/b")).status).toBe(400);

    const logout = await fetch(`${base}/auth/logout`, { method: "POST" });
    expect(await logout.json()).toEqual({ signedIn: false });
    expect((await get("/auth/status")).body.signedIn).toBe(false);
  });

  it("reports a cancelled sign-in and refuses odd redirect URIs", async () => {
    await start({ MISONOS_SPOTIFY_CLIENT_ID: "client-1" });
    expect(await get("/auth/callback?error=access_denied&state=x")).toEqual({ status: 400, body: { error: "Spotify sign-in was cancelled" } });
    expect((await get("/auth/login?redirect_uri=https%3A%2F%2Fevil.example%2Fsteal")).status).toBe(400);
  });

  it("uses a pinned redirect URI over the one the browser sends", async () => {
    await start({ MISONOS_SPOTIFY_CLIENT_ID: "client-1", MISONOS_SPOTIFY_REDIRECT_URI: REDIRECT });
    const login = await get("/auth/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A4173%2Fapi%2Fsources%2Fspotify%2Fauth%2Fcallback");
    expect(new URL(String(login.body.url)).searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect((await get("/auth/status")).body.redirectUri).toBe(REDIRECT);
  });

  it("treats a corrupt token file as signed out", async () => {
    await writeFile(path.join(dir, "token.json"), "{not json");
    await start({ MISONOS_SPOTIFY_CLIENT_ID: "client-1" });
    expect((await get("/auth/status")).body.signedIn).toBe(false);
  });
});

describe("redirectUri", () => {
  it("accepts http(s) URLs ending in the callback route only", () => {
    expect(redirectUri(REDIRECT)).toBe(REDIRECT);
    expect(redirectUri("http://127.0.0.1:4173/api/sources/spotify/auth/callback")).toBe("http://127.0.0.1:4173/api/sources/spotify/auth/callback");
    expect(redirectUri("")).toBeUndefined();
    expect(redirectUri("ftp://host/auth/callback")).toBeUndefined();
    expect(redirectUri("https://host/elsewhere")).toBeUndefined();
  });
});
