import { describe, expect, it } from "vitest";
import { cacheUntil } from "./client.js";
import { mimeTypeForExt, netscapeCookieFile, parseYtDlpOutput, resolveWithYtDlp, ytDlpArgs } from "./ytdlp.js";

describe("ytDlpArgs", () => {
  it("asks for one AAC-first audio format as JSON, with Node as the JS runtime", () => {
    const args = ytDlpArgs("1uYWYWPc9HU");
    expect(args).toContain("--ignore-config");
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe(`node:${process.execPath}`);
    expect(args[args.indexOf("-f") + 1]).toBe("bestaudio[ext=m4a]/bestaudio");
    expect(args[args.indexOf("--print") + 1]).toBe("%(.{url,ext,format_id,available_at})j");
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=1uYWYWPc9HU"]);
    expect(args).not.toContain("--extractor-args");
    expect(args).not.toContain("--cookies");
  });

  it("adds the player client and cookie file when given", () => {
    const args = ytDlpArgs("1uYWYWPc9HU", { playerClient: "visionos", cookieFile: "/tmp/c.txt" });
    expect(args[args.indexOf("--extractor-args") + 1]).toBe("youtube:player_client=visionos");
    expect(args[args.indexOf("--cookies") + 1]).toBe("/tmp/c.txt");
    expect(args.indexOf("--cookies")).toBeLessThan(args.indexOf("--"));
  });
});

describe("parseYtDlpOutput", () => {
  const url = "https://rr3---sn-x.googlevideo.com/videoplayback?expire=1795286712&itag=140";

  it("reads the printed format", () => {
    const stdout = `${JSON.stringify({ url, ext: "m4a", format_id: "140", available_at: 1795264626 })}\n`;
    expect(parseYtDlpOutput(stdout)).toEqual({ url, mimeType: "audio/mp4", formatId: "140", availableAt: 1795264626 });
  });

  it("ignores stray lines and a missing available_at", () => {
    const stdout = `[youtube] something\r\n${JSON.stringify({ url, ext: "webm", format_id: "251", available_at: null })}\r\n`;
    expect(parseYtDlpOutput(stdout)).toEqual({ url, mimeType: "audio/webm", formatId: "251", availableAt: undefined });
  });

  it("rejects output without a direct https URL", () => {
    expect(() => parseYtDlpOutput("")).toThrow(/no format/);
    expect(() => parseYtDlpOutput(JSON.stringify({ url: null, ext: "m4a" }))).toThrow(/no direct audio URL/);
  });
});

describe("mimeTypeForExt", () => {
  it("maps yt-dlp extensions to what the bridge and Sonos expect", () => {
    expect(mimeTypeForExt("m4a")).toBe("audio/mp4");
    expect(mimeTypeForExt(undefined)).toBe("audio/mp4");
    expect(mimeTypeForExt("mp3")).toBe("audio/mpeg");
    expect(mimeTypeForExt("webm")).toBe("audio/webm");
  });
});

describe("netscapeCookieFile", () => {
  it("writes each pasted cookie as a .youtube.com line", () => {
    const now = Date.UTC(2026, 10, 21);
    const file = netscapeCookieFile("SAPISID=abc/def; __Secure-3PSID=x=y;  junk ;=nope", now);
    const lines = file.trimEnd().split("\n");
    const expires = String(now / 1000 + 365 * 24 * 60 * 60);
    expect(lines).toEqual([
      "# Netscape HTTP Cookie File",
      [".youtube.com", "TRUE", "/", "TRUE", expires, "SAPISID", "abc/def"].join("\t"),
      [".youtube.com", "TRUE", "/", "TRUE", expires, "__Secure-3PSID", "x=y"].join("\t")
    ]);
  });
});

describe("resolveWithYtDlp", () => {
  it("refuses anything that is not a video id before running yt-dlp", async () => {
    await expect(resolveWithYtDlp("--exec=rm")).rejects.toThrow(/Bad video id/);
  });
});

describe("cacheUntil", () => {
  const now = Date.UTC(2026, 10, 21, 12);

  it("keeps a URL until ten minutes before it expires", () => {
    const expire = now / 1000 + 6 * 60 * 60;
    expect(cacheUntil(`https://x.googlevideo.com/videoplayback?expire=${expire}`, now)).toBe(expire * 1000 - 10 * 60 * 1000);
  });

  it("falls back to an hour without an expire, and never goes negative", () => {
    expect(cacheUntil("https://x.googlevideo.com/videoplayback", now)).toBe(now + 60 * 60 * 1000);
    expect(cacheUntil(`https://x.googlevideo.com/videoplayback?expire=${now / 1000 + 60}`, now)).toBe(now);
  });
});
