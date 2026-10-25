import { describe, expect, it } from "vitest";
import { SpotifyClient, SpotifyError } from "../src/spotify.js";

const auth = { accessToken: async () => "token", refresh: async () => "fresh" };

// Answers each call with the next reply: a status, or a thrown network error.
function scripted(replies: (number | Error)[], seen: string[] = []): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const reply = replies.shift();
    if (reply === undefined) throw new Error("unexpected call");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply < 400 ? { ok: true } : { error: { status: reply, message: `status ${reply}` } }), { status: reply });
  }) as typeof fetch;
}

describe("SpotifyClient", () => {
  it("tries once more after a network error or a 5xx", async () => {
    expect(await new SpotifyClient(auth, scripted([new TypeError("fetch failed"), 200])).get("/me")).toEqual({ ok: true });
    expect(await new SpotifyClient(auth, scripted([503, 200])).get("/me")).toEqual({ ok: true });
  });

  it("gives up after the second failure", async () => {
    await expect(new SpotifyClient(auth, scripted([new TypeError("fetch failed"), new TypeError("fetch failed")])).get("/me"))
      .rejects.toMatchObject({ status: 504 });
    await expect(new SpotifyClient(auth, scripted([503, 503])).get("/me")).rejects.toBeInstanceOf(SpotifyError);
  });

  it("doesn't retry client errors, and refreshes the token once on a 401", async () => {
    await expect(new SpotifyClient(auth, scripted([400])).get("/me")).rejects.toMatchObject({ status: 400, message: "Spotify: status 400 (400)" });
    const seen: string[] = [];
    expect(await new SpotifyClient(auth, scripted([401, 200], seen)).get("/me")).toEqual({ ok: true });
    expect(seen).toEqual(["Bearer token", "Bearer fresh"]);
  });

  it("only follows paging links back to the Web API", async () => {
    const client = new SpotifyClient(auth, scripted([]));
    await expect(client.collect({ items: [], next: "https://evil.example/v1/me" }, 10)).rejects.toThrow(/Unexpected paging URL/);
  });
});
