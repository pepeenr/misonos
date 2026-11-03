import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DowntifyClient, DowntifyError } from "../src/downtify.js";

interface Seen {
  method?: string;
  url?: string;
  host?: string;
  authorization?: string;
  body: string;
}

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

// A stand-in Downtify: answers each request with `reply`, and records what it got.
async function fakeDowntify(reply: (seen: Seen) => { status: number; body: string }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = {
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      };
      seen.push(entry);
      const { status, body } = reply(entry);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

describe("DowntifyClient", () => {
  it("sends the Host header and token, and asks for that exact video", async () => {
    const fake = await fakeDowntify(() => ({ status: 200, body: JSON.stringify("YouTube/Ripple.opus") }));
    const client = new DowntifyClient({ url: fake.url, host: "downtify.example" }, "dtfy_1_secret");

    const file = await client.download({ song_id: "aaaaaaaaaaa", name: "Ripple", url: "https://music.youtube.com/watch?v=aaaaaaaaaaa" });

    expect(file).toBe("YouTube/Ripple.opus");
    const [request] = fake.seen;
    expect(request.method).toBe("POST");
    expect(request.host).toBe("downtify.example");
    expect(request.authorization).toBe("Bearer dtfy_1_secret");
    const query = new URL(request.url ?? "", "http://x").searchParams;
    expect(query.get("url")).toBe("https://music.youtube.com/watch?v=aaaaaaaaaaa");
    expect(query.get("client_id")).toBe("misonos");
    expect(JSON.parse(request.body)).toEqual({ youtube_id: "aaaaaaaaaaa" });
  });

  it("resolves a link to a list of songs, one or many", async () => {
    const fake = await fakeDowntify((seen) => seen.url?.includes("list%3D")
      ? { status: 200, body: JSON.stringify([{ name: "One" }, { name: "Two" }]) }
      : { status: 200, body: JSON.stringify({ name: "Ripple" }) });
    const client = new DowntifyClient({ url: fake.url });

    expect(await client.resolve("https://youtu.be/aaaaaaaaaaa")).toEqual([{ name: "Ripple" }]);
    expect((await client.resolve("https://www.youtube.com/playlist?list=PL1")).map((song) => song.name)).toEqual(["One", "Two"]);
    expect(fake.seen[0].authorization).toBeUndefined();
  });

  it("asks for a song's radio by artist and title", async () => {
    const fake = await fakeDowntify(() => ({ status: 200, body: JSON.stringify({ artist: "A", track: "T", tracks: [{ name: "Next" }] }) }));
    const client = new DowntifyClient({ url: fake.url }, "dtfy_1_secret");

    expect(await client.similar("Grateful Dead", "Ripple", 10)).toEqual([{ name: "Next" }]);
    expect(fake.seen[0].url).toBe("/api/similar/tracks?artist=Grateful+Dead&track=Ripple&limit=10");
  });

  it("passes on Downtify's own error, and names a non-JSON answer by its status", async () => {
    const fake = await fakeDowntify((seen) => seen.url === "/api/auth/pair"
      ? { status: 401, body: JSON.stringify({ detail: "Wrong or expired pairing code" }) }
      : { status: 503, body: "<html>Site not available</html>" });
    const client = new DowntifyClient({ url: fake.url });

    await expect(client.pair("000000", "MiSonos")).rejects.toEqual(new DowntifyError("Wrong or expired pairing code", 401));
    await expect(client.resolve("https://youtu.be/aaaaaaaaaaa")).rejects.toEqual(new DowntifyError("Downtify answered 503", 503));
    expect(JSON.parse(fake.seen[0].body)).toEqual({ code: "000000", device_name: "MiSonos", platform: "misonos" });
  });
});
