import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPES, SpotifyAuth } from "../src/auth.js";

const REDIRECT = "https://misonos.example/api/sources/spotify/auth/callback";

interface TokenCall { form: URLSearchParams }

// A fake accounts.spotify.com token endpoint answering each grant with `reply`.
function fakeTokens(reply: (form: URLSearchParams) => { status?: number; body: object }, calls: TokenCall[] = []): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe("https://accounts.spotify.com/api/token");
    const form = new URLSearchParams(String(init?.body));
    calls.push({ form });
    const { status = 200, body } = reply(form);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("SpotifyAuth", () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "spotify-auth-"));
    tokenPath = path.join(dir, "nested", "spotify-token.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("signs in with PKCE and persists the tokens", async () => {
    const calls: TokenCall[] = [];
    const auth = new SpotifyAuth("client-1", tokenPath, fakeTokens(() => ({
      body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: SCOPES.join(" ") }
    }), calls));

    const authorize = new URL(auth.beginLogin(REDIRECT));
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.spotify.com/authorize");
    const params = authorize.searchParams;
    expect(params.get("client_id")).toBe("client-1");
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(params.get("scope")).toBe(SCOPES.join(" "));
    expect(params.get("code_challenge_method")).toBe("S256");

    await auth.completeLogin("the-code", params.get("state") ?? "");
    const form = calls[0].form;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    expect(form.get("client_secret")).toBeNull();
    // The verifier sent with the code is the one the challenge was made from.
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    expect(challenge).toBe(params.get("code_challenge"));

    expect(await auth.accessToken()).toBe("access-1");
    expect(JSON.parse(await readFile(tokenPath, "utf8"))).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    if (process.platform !== "win32") expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);

    // A fresh process reads the stored sign-in back.
    const reloaded = new SpotifyAuth("client-1", tokenPath, fakeTokens(() => ({ status: 500, body: {} })));
    expect(await reloaded.status()).toEqual({ signedIn: true, user: undefined });
  });

  it("rejects an unknown or reused state", async () => {
    const auth = new SpotifyAuth("client-1", tokenPath, fakeTokens(() => ({
      body: { access_token: "a", refresh_token: "r", expires_in: 3600 }
    })));
    await expect(auth.completeLogin("code", "made-up")).rejects.toThrow(/expired or was already used/);
    const state = new URL(auth.beginLogin(REDIRECT)).searchParams.get("state") ?? "";
    await auth.completeLogin("code", state);
    await expect(auth.completeLogin("code", state)).rejects.toThrow(/expired or was already used/);
  });

  it("refreshes an expired token once for concurrent callers, keeping the refresh token when none is returned", async () => {
    const calls: TokenCall[] = [];
    let issued = 0;
    const auth = new SpotifyAuth("client-1", tokenPath, fakeTokens((form) => {
      issued += 1;
      if (form.get("grant_type") === "authorization_code") return { body: { access_token: "old", refresh_token: "refresh-1", expires_in: 0 } };
      return { body: { access_token: `new-${issued}`, expires_in: 3600 } };
    }, calls));
    await auth.completeLogin("code", new URL(auth.beginLogin(REDIRECT)).searchParams.get("state") ?? "");

    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(new Set(tokens)).toEqual(new Set(["new-2"]));
    expect(calls.filter((call) => call.form.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(calls[1].form.get("refresh_token")).toBe("refresh-1");
    expect(JSON.parse(await readFile(tokenPath, "utf8"))).toMatchObject({ accessToken: "new-2", refreshToken: "refresh-1" });
  });

  it("signs out when Spotify rejects the refresh token", async () => {
    const auth = new SpotifyAuth("client-1", tokenPath, fakeTokens((form) => form.get("grant_type") === "authorization_code"
      ? { body: { access_token: "old", refresh_token: "revoked", expires_in: 0 } }
      : { status: 400, body: { error: "invalid_grant", error_description: "Refresh token revoked" } }));
    await auth.completeLogin("code", new URL(auth.beginLogin(REDIRECT)).searchParams.get("state") ?? "");

    await expect(auth.accessToken()).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/Connect Spotify again/) });
    expect(await auth.status()).toEqual({ signedIn: false });
    await expect(readFile(tokenPath, "utf8")).rejects.toThrow();
  });
});
