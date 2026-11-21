import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getStreamUrl, getTrackInfo } = vi.hoisted(() => ({ getStreamUrl: vi.fn(), getTrackInfo: vi.fn() }));
vi.mock("./client.js", async (importActual) => ({ ...(await importActual<typeof import("./client.js")>()), getStreamUrl }));
vi.mock("./ytmApi.js", async (importActual) => ({ ...(await importActual<typeof import("./ytmApi.js")>()), getTrackInfo }));

const { createServer } = await import("./server.js");

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer({ serviceName: "YouTube Music", port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  getStreamUrl.mockReset();
  getStreamUrl.mockResolvedValue({ url: "https://rr1.googlevideo.com/videoplayback?itag=140", mimeType: "audio/mp4" });
  getTrackInfo.mockReset();
  getTrackInfo.mockResolvedValue({ videoId: "1uYWYWPc9HU", title: "Karma Police", artist: "Radiohead", durationSeconds: 263 });
});

describe("GET /track", () => {
  it("answers with the stream URL", async () => {
    const response = await fetch(`${base}/track?id=t:1uYWYWPc9HU`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "Karma Police", url: "https://rr1.googlevideo.com/videoplayback?itag=140", mimeType: "audio/mp4" });
    expect(getStreamUrl).toHaveBeenCalledWith("1uYWYWPc9HU");
  });

  it("answers with metadata only, without running yt-dlp, for stream=0", async () => {
    const response = await fetch(`${base}/track?id=t:1uYWYWPc9HU&stream=0`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "t:1uYWYWPc9HU", title: "Karma Police", artist: "Radiohead", url: "", mimeType: "audio/mp4" });
    expect(getStreamUrl).not.toHaveBeenCalled();
  });
});
