import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchTrack } = vi.hoisted(() => ({ fetchTrack: vi.fn() }));
vi.mock("../src/sources.js", () => ({ fetchTrack }));
vi.mock("../src/meter.js", () => ({ meterStream: vi.fn() }));
const { proxyStream } = await import("../src/streamProxy.js");

// A source's stream host, where /kept stops working partway (as a YouTube URL does once
// the public IP it was found from changes).
let keptStatus = 200;
const upstream = http.createServer((request, response) => {
  const status = request.url === "/kept" ? keptStatus : request.url === "/dead" ? 403 : 200;
  response.writeHead(status, { "content-type": "audio/mpeg" });
  response.end(status === 200 ? `bytes from ${request.url}` : "Forbidden");
});
const proxy = http.createServer((request, response) => {
  const trackId = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
  void proxyStream("navidrome", trackId, request, response);
});

const base = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const listen = (server: http.Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

async function play(trackId: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base(proxy)}/${trackId}`, { headers: { range: "bytes=1000-" } });
  return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
  await listen(upstream);
  await listen(proxy);
});
afterAll(() => {
  upstream.close();
  proxy.close();
});

describe("the stream proxy", () => {
  beforeEach(() => {
    fetchTrack.mockReset();
    keptStatus = 200;
  });

  it("looks a track up again when the stream URL it kept stops working, instead of failing the song", async () => {
    fetchTrack
      .mockResolvedValueOnce({ id: "a", title: "A", url: `${base(upstream)}/kept`, mimeType: "audio/mpeg" })
      .mockResolvedValueOnce({ id: "a", title: "A", url: `${base(upstream)}/fresh`, mimeType: "audio/mpeg" });
    expect(await play("kept-1")).toEqual({ status: 200, body: "bytes from /kept" });

    // The speaker reconnects partway through the song.
    keptStatus = 403;
    expect(await play("kept-1")).toEqual({ status: 200, body: "bytes from /fresh" });
    expect(fetchTrack).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a stream URL that failed as soon as it was found", async () => {
    fetchTrack.mockResolvedValue({ id: "b", title: "B", url: `${base(upstream)}/dead`, mimeType: "audio/mpeg" });
    expect((await play("dead-1")).status).toBe(403);
    expect(fetchTrack).toHaveBeenCalledTimes(1);
    // The next try finds it again rather than reusing the dead URL for minutes.
    expect((await play("dead-1")).status).toBe(403);
    expect(fetchTrack).toHaveBeenCalledTimes(2);
  });
});
