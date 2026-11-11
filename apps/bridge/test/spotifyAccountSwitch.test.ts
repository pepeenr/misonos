import type { NowPlaying, SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SonosSoapError } from "../src/sonosSoap.js";
import { SonosService } from "../src/sonosService.js";
import {
  isSonosSpotifyUri,
  queuedItemOnAccount,
  spotifyAccountOfUri,
  spotifyArtistRadioItem,
  withSpotifyAccount,
  withSpotifyToken
} from "../src/spotifySonos.js";

const { callSoap, discoverSsdp } = vi.hoisted(() => ({ callSoap: vi.fn(), discoverSsdp: vi.fn() }));
vi.mock("../src/ssdp.js", () => ({ discoverSsdp }));
vi.mock("../src/sonosSoap.js", async (importActual) => ({ ...(await importActual<typeof import("../src/sonosSoap.js")>()), callSoap }));

const PEPE = { sid: 9, sn: 3, token: "SA_RINCON2311_X_#Svc2311-0000aaaa-Token" };
const MIA = { sid: 9, sn: 5, token: "SA_RINCON2311_X_#Svc2311-0000bbbb-Token" };

const songUri = (id: string, sn: number) => `x-sonos-spotify:spotify%3atrack%3a${id}?sid=9&flags=8232&sn=${sn}`;
const RADIO_ON_PEPE = "x-sonosapi-radio:spotify%3aartistRadio%3aART1?sid=9&flags=8300&sn=3";

describe("Spotify login URIs", () => {
  it("tells which login a song, an album or radio plays on", () => {
    expect(spotifyAccountOfUri(songUri("abc", 3))).toEqual({ sid: 9, sn: 3 });
    expect(spotifyAccountOfUri("x-rincon-cpcontainer:1006206cspotify%3aalbum%3axyz?sid=9&flags=8300&sn=5")).toEqual({ sid: 9, sn: 5 });
    expect(spotifyAccountOfUri(RADIO_ON_PEPE)).toEqual({ sid: 9, sn: 3 });
    expect(spotifyAccountOfUri("x-sonosapi-stream:s123?sid=254&flags=8224&sn=0")).toBeUndefined();
    expect(isSonosSpotifyUri("http://10.0.0.84:6173/api/stream/navidrome/t1/song.mp3")).toBe(false);
  });

  it("moves a URI and its token to another login", () => {
    expect(withSpotifyAccount(songUri("abc", 3), MIA)).toBe(songUri("abc", 5));
    expect(withSpotifyAccount("x-sonosapi-stream:s123?sid=254&sn=0", MIA)).toBe("x-sonosapi-stream:s123?sid=254&sn=0");
    const metadata = `<DIDL-Lite><item id="x"><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${PEPE.token}</desc></item></DIDL-Lite>`;
    expect(withSpotifyToken(metadata, MIA.token)).toContain(`>${MIA.token}</desc>`);
    expect(withSpotifyToken(metadata, MIA.token)).not.toContain(PEPE.token);
  });

  it("queues a Spotify song again on the new login, and anything else as it was", () => {
    const song = queuedItemOnAccount({ uri: songUri("abc", 3), xml: "<item/>", title: "Song", artist: "Artist", album: "Album" }, MIA);
    expect(song).toMatchObject({ uri: "x-sonos-spotify:spotify%3Atrack%3Aabc?sid=9&flags=8232&sn=5", spotify: true });
    expect(song.metadata).toContain("<dc:title>Song</dc:title>");
    expect(song.metadata).toContain(MIA.token);

    const proxied = "http://10.0.0.84:6173/api/stream/navidrome/t1/song.mp3";
    const other = queuedItemOnAccount({ uri: proxied, xml: `<item id="Q:0/2" parentID="Q:0" restricted="true"><dc:title>Local</dc:title><res>${proxied}</res></item>`, title: "Local" }, MIA);
    expect(other.spotify).toBe(false);
    expect(other.uri).toBe(proxied);
    expect(other.metadata).toContain('<item id="-1" parentID="-1" restricted="true"><dc:title>Local</dc:title>');
  });

  it("builds Spotify artist radio the way the Sonos app does", () => {
    const radio = spotifyArtistRadioItem({ id: "ART1", name: "Sofi Tukker" }, PEPE);
    expect(radio.uri).toBe(RADIO_ON_PEPE);
    expect(radio.metadata).toContain('<item id="100c206cspotify%3aartistRadio%3aART1" parentID="10052064spotify%3aartist%3aART1" restricted="true">');
    expect(radio.metadata).toContain("<dc:title>Sofi Tukker Radio</dc:title>");
    expect(radio.metadata).toContain("<upnp:class>object.item.audioItem.audioBroadcast.#artistRadio</upnp:class>");
    expect(radio.metadata).toContain(PEPE.token);
  });
});

const OFFICE: SonosZone = { id: "RINCON_A", uuid: "RINCON_A", name: "Office", ipAddress: "10.0.0.35", location: "", coordinatorId: "RINCON_A", groupId: "RINCON_A:1", visible: true };
const GROUP: SonosGroup = { id: "RINCON_A:1", coordinatorId: "RINCON_A", coordinatorName: "Office", zones: [OFFICE] };
const QUEUE_URI = "x-rincon-queue:RINCON_A#0";

function service(): SonosService {
  const service = new SonosService({ ...loadConfig(), manualSpeakerIps: [] });
  const state = service as unknown as { zones: Map<string, SonosZone>; groups: Map<string, SonosGroup>; lastDiscovery: number; nowPlayingSettled: () => Promise<NowPlaying> };
  state.zones = new Map([[OFFICE.uuid, OFFICE]]);
  state.groups = new Map([[GROUP.id, GROUP]]);
  state.lastDiscovery = Date.now();
  state.nowPlayingSettled = async () => ({ groupId: GROUP.id, state: "PLAYING", updatedAt: "" }) as NowPlaying;
  return service;
}

function queueItem(index: number, uri: string, title: string): string {
  return `<item id="Q:0/${index}" parentID="Q:0" restricted="true"><res protocolInfo="sonos.com-spotify:*:audio/x-spotify:*">${uri.replaceAll("&", "&amp;")}</res>` +
    `<dc:title>${title}</dc:title><dc:creator>Artist</dc:creator><upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${PEPE.token}</desc></item>`;
}

/** A coordinator playing `currentUri` (track 2 at 1:05) over a queue of `queue`. */
function speaker(currentUri: string, queue: string[], state = "PLAYING", options: { noMultiple?: boolean } = {}) {
  callSoap.mockImplementation(async (_ip: string, _service: string, action: string) => {
    if (action === "GetMediaInfo") return { CurrentURI: currentUri, CurrentURIMetaData: `<DIDL-Lite><item><desc id="cdudn">${PEPE.token}</desc></item></DIDL-Lite>` };
    if (action === "GetPositionInfo") return { Track: "2", RelTime: "0:01:05" };
    if (action === "GetTransportInfo") return { CurrentTransportState: state };
    if (action === "Browse") {
      return { Result: `<DIDL-Lite>${queue.map((uri, index) => queueItem(index + 1, uri, `Song ${index + 1}`)).join("")}</DIDL-Lite>`, TotalMatches: String(queue.length) };
    }
    if (action === "AddMultipleURIsToQueue" && options.noMultiple) throw new SonosSoapError("Invalid action (code=401)", 500, "401");
    return {};
  });
}

const calls = (action: string) => callSoap.mock.calls.filter((call) => call[2] === action).map((call) => call[3] as Record<string, unknown>);
const actions = () => callSoap.mock.calls.map((call) => call[2] as string).filter((action) => !action.startsWith("Get") && action !== "Browse");

describe("moving the music to another Spotify login", () => {
  beforeEach(() => {
    callSoap.mockReset();
    discoverSsdp.mockReset();
  });

  it("queues the songs again on the new login after the queue, carries on from the same song and second, then drops the old ones", async () => {
    speaker(QUEUE_URI, [songUri("a", 3), songUri("b", 3), "http://10.0.0.84:6173/api/stream/navidrome/t1/x.mp3"]);
    const result = await service().moveSpotifyToAccount(GROUP.id, MIA);
    expect(result.moved).toBe(2);
    expect(actions()).toEqual(["AddMultipleURIsToQueue", "Seek", "Seek", "Play", "RemoveTrackRangeFromQueue"]);
    const added = calls("AddMultipleURIsToQueue")[0];
    expect(added.NumberOfURIs).toBe(3);
    expect(String(added.EnqueuedURIs).split(" ")).toEqual([
      "x-sonos-spotify:spotify%3Atrack%3Aa?sid=9&flags=8232&sn=5",
      "x-sonos-spotify:spotify%3Atrack%3Ab?sid=9&flags=8232&sn=5",
      "http://10.0.0.84:6173/api/stream/navidrome/t1/x.mp3"
    ]);
    expect(String(added.EnqueuedURIsMetaData)).toContain(MIA.token);
    expect(calls("Seek")).toEqual([
      { InstanceID: 0, Unit: "TRACK_NR", Target: "5" },
      { InstanceID: 0, Unit: "REL_TIME", Target: "0:01:05" }
    ]);
    expect(calls("RemoveTrackRangeFromQueue")[0]).toMatchObject({ StartingIndex: 1, NumberOfTracks: 3 });
  });

  it("stays paused when it was paused", async () => {
    speaker(QUEUE_URI, [songUri("a", 3), songUri("b", 3)], "PAUSED_PLAYBACK");
    await service().moveSpotifyToAccount(GROUP.id, MIA);
    expect(actions()).not.toContain("Play");
  });

  it("queues one by one when the speaker won't take several at once", async () => {
    speaker(QUEUE_URI, [songUri("a", 3), songUri("b", 3)], "PLAYING", { noMultiple: true });
    await service().moveSpotifyToAccount(GROUP.id, MIA);
    expect(calls("AddURIToQueue").map((args) => args.EnqueuedURI)).toEqual([
      "x-sonos-spotify:spotify%3Atrack%3Aa?sid=9&flags=8232&sn=5",
      "x-sonos-spotify:spotify%3Atrack%3Ab?sid=9&flags=8232&sn=5"
    ]);
  });

  it("does nothing when the queue is already on that login, or has no Spotify songs", async () => {
    speaker(QUEUE_URI, [songUri("a", 5)]);
    expect((await service().moveSpotifyToAccount(GROUP.id, MIA)).moved).toBe(0);
    speaker(QUEUE_URI, ["http://10.0.0.84:6173/api/stream/navidrome/t1/x.mp3"]);
    expect((await service().moveSpotifyToAccount(GROUP.id, MIA)).moved).toBe(0);
    expect(actions()).toEqual([]);
  });

  it("tunes Spotify radio again on the new login", async () => {
    speaker(RADIO_ON_PEPE, []);
    expect((await service().moveSpotifyToAccount(GROUP.id, MIA)).moved).toBe(1);
    expect(actions()).toEqual(["SetAVTransportURI", "Play"]);
    const tuned = calls("SetAVTransportURI")[0];
    expect(tuned.CurrentURI).toBe("x-sonosapi-radio:spotify%3aartistRadio%3aART1?sid=9&flags=8300&sn=5");
    expect(String(tuned.CurrentURIMetaData)).toContain(MIA.token);
  });

  it("leaves Spotify Connect and the TV alone", async () => {
    speaker("x-sonos-vli:RINCON_A:1,spotify:abc", []);
    expect((await service().moveSpotifyToAccount(GROUP.id, MIA)).moved).toBe(0);
    expect(actions()).toEqual([]);
  });
});

describe("Spotify artist radio", () => {
  beforeEach(() => callSoap.mockReset());

  it("tunes the artist's radio on the login and plays, leaving the queue", async () => {
    speaker(QUEUE_URI, []);
    await service().playSpotifyArtistRadio(GROUP.id, { id: "ART1", name: "Sofi Tukker" }, PEPE);
    expect(actions()).toEqual(["SetAVTransportURI", "Play"]);
    expect(calls("SetAVTransportURI")[0].CurrentURI).toBe(RADIO_ON_PEPE);
  });
});
