import { spawn } from "node:child_process";
import type http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decoder, meterStream, subscribeMeter } from "../src/meter.js";

const realSpawn = decoder.spawn;
afterEach(() => { decoder.spawn = realSpawn; });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the VU meter's decoder", () => {
  it("survives a decoder that stops reading while the song still streams", async () => {
    // Like ffmpeg giving up on its input: stdin closes, the process lingers a moment.
    decoder.spawn = () => spawn(process.execPath, ["-e", "process.stdin.destroy(); setTimeout(() => {}, 500)"]);
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onError);
    try {
      const bytes = new PassThrough();
      bytes.resume(); // the speaker's side, reading along
      meterStream("test", `quits-${Date.now()}`, bytes, undefined);
      for (let i = 0; i < 40; i++) {
        bytes.write(Buffer.alloc(64 * 1024));
        await wait(20);
      }
      bytes.end();
      // The writes still queued fail once the decoder is gone.
      await wait(1500);
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(errors).toEqual([]);
  }, 10_000);
});

// A web meter's event stream: what it was sent.
function meterClient() {
  const sent: string[] = [];
  const response = { write: (text: string) => { sent.push(text); return true; }, on: () => response, end: () => undefined };
  return { response: response as unknown as http.ServerResponse, sent, windows: () => sent.filter((text) => text.startsWith("event: w")).length, inits: () => sent.filter((text) => text.startsWith("event: init")) };
}

// Stereo float samples, as the decoder hands them over: `count` 40 ms windows at 8 kHz.
function pcmWindows(count: number): Buffer {
  const samples = Buffer.alloc(count * 320 * 8);
  for (let offset = 0; offset < samples.length; offset += 4) samples.writeFloatLE(0.5, offset);
  return samples;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await wait(20);
}

describe("the VU meter's levels", () => {
  // A decoder stand-in that hands its input straight back, as if it were already PCM.
  const echo = () => spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]);

  it("start for a meter opened before the speaker fetched the track", async () => {
    decoder.spawn = echo;
    const track = `early-${Date.now()}`;
    const client = meterClient();
    subscribeMeter("test", track, client.response);
    expect(client.inits()).toHaveLength(1);

    const bytes = new PassThrough();
    bytes.resume();
    meterStream("test", track, bytes, undefined);
    bytes.end(pcmWindows(10));
    await until(() => client.windows() >= 10);
    expect(client.windows()).toBe(10);
  }, 10_000);

  it("are decoded again when the track plays again, and an open meter starts over with them", async () => {
    decoder.spawn = echo;
    const track = `again-${Date.now()}`;
    const client = meterClient();
    subscribeMeter("test", track, client.response);

    // The first time, the song was skipped after three windows.
    const first = new PassThrough();
    first.resume();
    meterStream("test", track, first, "bytes=0-");
    first.end(pcmWindows(3));
    await until(() => client.windows() >= 3);
    await wait(1500); // the decoder quits once its input ends

    const second = new PassThrough();
    second.resume();
    meterStream("test", track, second, "bytes=0-");
    second.end(pcmWindows(8));
    await until(() => client.windows() >= 11);
    expect(client.inits()).toHaveLength(2);
    expect(client.inits()[1]).toContain("\"windows\":[]");
    expect(client.windows()).toBe(11);
  }, 10_000);
});
