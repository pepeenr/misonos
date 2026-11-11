import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying, SonosSpotifyAccount } from "@misonos/sonos-protocol";
import { SpotifyNowPlaying } from "./SpotifyNowPlaying.js";
import { isSpotifySongUri, loginChoices, spotifyLoginOfUri } from "./spotifyLogins.js";

const login = (sn: number, name?: string): SonosSpotifyAccount => ({ sid: 9, sn, token: `SA_RINCON2311_X_#Svc2311-${sn}-Token`, seenOn: [], uses: 1, name });
const SONG_ON_PEPE = "x-sonos-spotify:spotify%3atrack%3aabc?sid=9&flags=8232&sn=3";

describe("Spotify logins", () => {
  it("reads the login a Spotify song or Spotify radio plays on", () => {
    expect(spotifyLoginOfUri(SONG_ON_PEPE)).toEqual({ sid: 9, sn: 3 });
    expect(spotifyLoginOfUri("x-sonosapi-radio:spotify%3aartistRadio%3aART?sid=9&flags=8300&sn=5")).toEqual({ sid: 9, sn: 5 });
    expect(spotifyLoginOfUri("x-sonosapi-stream:s1?sid=254&sn=0")).toBeUndefined();
    expect(spotifyLoginOfUri(undefined)).toBeUndefined();
    expect(isSpotifySongUri(SONG_ON_PEPE)).toBe(true);
    expect(isSpotifySongUri("x-sonosapi-radio:spotify%3aartistRadio%3aART?sid=9&sn=5")).toBe(false);
  });

  it("offers the named logins once any has a name, and always the one playing", () => {
    const accounts = [login(3, "Pepe"), login(5, "Mia"), login(6)];
    expect(loginChoices(accounts, { sid: 9, sn: 3 }).map((a) => a.sn)).toEqual([3, 5]);
    expect(loginChoices(accounts, { sid: 9, sn: 6 }).map((a) => a.sn)).toEqual([3, 5, 6]);
    expect(loginChoices([login(3), login(5)], { sid: 9, sn: 3 }).map((a) => a.sn)).toEqual([3, 5]);
  });
});

describe("the Spotify controls under the song", () => {
  let posts: { url: string; body: unknown }[];

  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/api/spotify/accounts")) return json({ accounts: [login(3, "Pepe"), login(5, "Mia"), login(6)] });
      const playing = { groupId: "g1", state: "PLAYING", title: "Song", updatedAt: new Date().toISOString() };
      if (url.endsWith("/spotify-account")) return json({ moved: 4, nowPlaying: { ...playing, uri: SONG_ON_PEPE.replace("sn=3", "sn=5") } });
      if (url.endsWith("/spotify-radio")) return json({ artist: { id: "ART", name: "Sofi Tukker" }, nowPlaying: playing });
      return json({});
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const nowPlaying: NowPlaying = { groupId: "g1", state: "PLAYING", title: "Song", uri: SONG_ON_PEPE, updatedAt: "" };

  it("switches the music to Mia's login", async () => {
    const onPlayed = vi.fn();
    render(<SpotifyNowPlaying groupId="g1" nowPlaying={nowPlaying} onPlayed={onPlayed} />);
    const select = await screen.findByRole("combobox", { name: "Spotify login" });
    expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["Pepe", "Mia"]);
    expect((select as HTMLSelectElement).value).toBe("9:3");
    fireEvent.change(select, { target: { value: "9:5" } });
    await waitFor(() => expect(onPlayed).toHaveBeenCalled());
    expect(posts).toEqual([{ url: expect.stringContaining("/api/groups/g1/spotify-account"), body: { sid: 9, sn: 5 } }]);
    expect(await screen.findByText("Spotify plays on Mia now.")).toBeTruthy();
  });

  it("starts the artist's Spotify radio from the song", async () => {
    const onPlayed = vi.fn();
    render(<SpotifyNowPlaying groupId="g1" nowPlaying={nowPlaying} onPlayed={onPlayed} />);
    fireEvent.click(screen.getByRole("button", { name: "Artist radio" }));
    expect(await screen.findByText("Playing Sofi Tukker Radio.")).toBeTruthy();
    expect(posts[0].url).toContain("/api/groups/g1/spotify-radio");
    expect(onPlayed).toHaveBeenCalled();
  });

  it("has no radio button while Spotify radio already plays", async () => {
    render(<SpotifyNowPlaying groupId="g1" nowPlaying={{ ...nowPlaying, uri: "x-sonosapi-radio:spotify%3aartistRadio%3aART?sid=9&flags=8300&sn=3" }} onPlayed={() => {}} />);
    await screen.findByRole("combobox", { name: "Spotify login" });
    expect(screen.queryByRole("button", { name: "Artist radio" })).toBeNull();
  });
});
