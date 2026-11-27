import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decoder, meterStream } from "../src/meter.js";

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
