import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { readSavedLogin, type SavedLogin } from "../src/login.js";
import { createServer } from "../src/server.js";

const realFetch = globalThis.fetch;
const PASSWORDS: Record<string, string> = { me: "secret", other: "hunter2" };

// A fake Navidrome that checks token auth (t = md5(password + s)) on every call.
function fakeNavidrome(seen: URL[]): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "nd.test") return realFetch(input, init);
    seen.push(url);
    const password = PASSWORDS[url.searchParams.get("u") ?? ""];
    const expected = password && createHash("md5").update(password + url.searchParams.get("s")).digest("hex");
    const payload = expected && expected === url.searchParams.get("t")
      ? { status: "ok", genres: { genre: [] } }
      : { status: "failed", error: { code: 40, message: "Wrong username or password" } };
    return new Response(JSON.stringify({ "subsonic-response": payload }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("saved login", () => {
  let dir: string;
  let loginPath: string;
  let server: http.Server;
  let base: string;
  let seen: URL[];

  async function start(env: Record<string, string> = {}): Promise<void> {
    const config = loadConfig({ ...env, MISONOS_NAVIDROME_LOGIN_PATH: loginPath });
    server = createServer(config, await readSavedLogin(loginPath));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (route: string, body: unknown) =>
    realFetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "navidrome-login-"));
    loginPath = path.join(dir, "navidrome-login.json");
    seen = [];
    vi.stubGlobal("fetch", fakeNavidrome(seen));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a login the server rejects, and saves nothing", async () => {
    await start();
    expect(await (await realFetch(`${base}/config`)).json()).toEqual({ source: "none", envConfigured: false });
    const response = await post("/config", { serverUrl: "http://nd.test", username: "me", password: "wrong" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Wrong username or password" });
    await expect(readFile(loginPath)).rejects.toThrow();
    expect((await realFetch(`${base}/info`)).status).toBe(503);
  });

  it("validates the form before calling the server", async () => {
    await start();
    expect((await post("/config", { serverUrl: "nd.test", username: "me", password: "secret" })).status).toBe(400);
    expect((await post("/config", { serverUrl: "http://nd.test", username: "me" })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("saves a working login as salt + token only, and serves the library with it", async () => {
    await start();
    const response = await post("/config", { serverUrl: "http://nd.test/", username: "me", password: "secret" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: "saved", serverUrl: "http://nd.test", username: "me", envConfigured: false });

    const file = await readFile(loginPath, "utf8");
    expect(file).not.toContain("secret");
    const saved = JSON.parse(file) as SavedLogin;
    expect(saved).toMatchObject({ serverUrl: "http://nd.test", username: "me" });

    expect((await realFetch(`${base}/info`)).status).toBe(200);
    const browse = await realFetch(`${base}/browse?id=${encodeURIComponent("genres")}`);
    await browse.arrayBuffer();
    const last = seen[seen.length - 1];
    expect(last.searchParams.get("s")).toBe(saved.salt);
    expect(last.searchParams.get("t")).toBe(saved.token);
  });

  it("prefers a saved login over the env, and falls back to the env when it's cleared", async () => {
    const env = { MISONOS_NAVIDROME_SERVER_URL: "http://nd.test", MISONOS_NAVIDROME_USER: "me", MISONOS_NAVIDROME_PASSWORD: "secret" };
    await start(env);
    await post("/config", { serverUrl: "http://nd.test", username: "other", password: "hunter2" });
    await new Promise((resolve) => server.close(resolve));

    // A restart picks the saved login back up.
    await start(env);
    expect(await (await realFetch(`${base}/config`)).json()).toMatchObject({ source: "saved", username: "other", envConfigured: true });

    const cleared = await post("/config/clear", {});
    expect(await cleared.json()).toEqual({ source: "env", serverUrl: "http://nd.test", username: "me", envConfigured: true });
    await expect(readFile(loginPath)).rejects.toThrow();
    expect((await realFetch(`${base}/info`)).status).toBe(200);
  });

  it("ignores an unreadable login file", async () => {
    await writeFile(loginPath, "{ not json");
    expect(await readSavedLogin(loginPath)).toBeUndefined();
    await writeFile(loginPath, JSON.stringify({ serverUrl: "http://nd.test", username: "me" }));
    expect(await readSavedLogin(loginPath)).toBeUndefined();
    await start();
  });
});
