import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// YouTube Music stream URLs come from yt-dlp. youtubei.js stopped getting playable
// URLs in 2026-11: every player client it has either errors or hands out a URL that
// googlevideo cuts off after ~1 MB (the PO-token gate). yt-dlp keeps working because
// its maintainers chase each change within days (which clients still stream, the JS
// signature challenges, the wait for the pre-roll ad), so the cat-and-mouse is theirs
// instead of ours. The container ships the newest release on every build and can
// update it in place (YTDLP_AUTO_UPDATE=1), so a fix reaches us without a deploy.

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Bounds one yt-dlp run. It usually takes 2–5 s; the bridge gives a track 30 s in all.
const RESOLVE_TIMEOUT_MS = 20_000;
// A playlist enqueue asks for every track at once; each run is a Python process plus a
// Node child for the JS challenges, so only a few run at the same time.
const MAX_CONCURRENT_RUNS = 3;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YtDlpOptions {
  /** yt-dlp's `player_client` extractor arg; omit for yt-dlp's own default clients. */
  playerClient?: string;
  /** A Netscape cookie file, for content that streams only when signed in. */
  cookieFile?: string;
}

export interface YtDlpStream {
  url: string;
  mimeType: string;
  /** Epoch seconds before which googlevideo answers 403 (YouTube makes clients sit out
   * the pre-roll ad); yt-dlp works it out from the ads in the player response. */
  availableAt?: number;
  formatId?: string;
}

export class YtDlpMissingError extends Error {
  constructor() {
    super(`yt-dlp is not installed (looked for "${YTDLP}"; set YTDLP_PATH to point at it)`);
    this.name = "YtDlpMissingError";
  }
}

export function ytDlpArgs(videoId: string, options: YtDlpOptions = {}): string[] {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "10",
    // The tv and web clients sign their URLs with JS challenges that yt-dlp solves in a
    // JS runtime. Only Deno is on by default; the Node running us is always there.
    "--js-runtimes", `node:${process.execPath}`,
    // AAC in MP4 plays on every Sonos; anything else only if a video has no AAC.
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "--print", "%(.{url,ext,format_id,available_at})j"
  ];
  if (options.playerClient) args.push("--extractor-args", `youtube:player_client=${options.playerClient}`);
  if (options.cookieFile) args.push("--cookies", options.cookieFile);
  args.push("--", `https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

/** Reads the one JSON line `--print` writes for the chosen format. */
export function parseYtDlpOutput(stdout: string): YtDlpStream {
  const line = stdout.split(/\r?\n/).map((part) => part.trim()).filter((part) => part.startsWith("{")).pop();
  if (!line) throw new Error("yt-dlp printed no format");
  const parsed = JSON.parse(line) as { url?: unknown; ext?: unknown; format_id?: unknown; available_at?: unknown };
  if (typeof parsed.url !== "string" || !/^https:\/\//.test(parsed.url)) {
    // Formats delivered as manifests (HLS/DASH) have no single URL Sonos could play.
    throw new Error("yt-dlp found no direct audio URL");
  }
  return {
    url: parsed.url,
    mimeType: mimeTypeForExt(typeof parsed.ext === "string" ? parsed.ext : undefined),
    availableAt: typeof parsed.available_at === "number" ? parsed.available_at : undefined,
    formatId: typeof parsed.format_id === "string" ? parsed.format_id : undefined
  };
}

export function mimeTypeForExt(ext: string | undefined): string {
  switch (ext) {
    case undefined:
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return `audio/${ext}`;
  }
}

/** The pasted "a=b; c=d" cookie header as a Netscape cookie file for `--cookies`. */
export function netscapeCookieFile(cookie: string, now = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + 365 * 24 * 60 * 60);
  const lines = ["# Netscape HTTP Cookie File"];
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    lines.push([".youtube.com", "TRUE", "/", "TRUE", expires, name, value].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export async function resolveWithYtDlp(videoId: string, options: YtDlpOptions = {}): Promise<YtDlpStream> {
  if (!VIDEO_ID.test(videoId)) throw new Error(`Bad video id: ${videoId}`);
  return withRunSlot(async () => parseYtDlpOutput(await runYtDlp(ytDlpArgs(videoId, options), RESOLVE_TIMEOUT_MS)));
}

let cookieFileCounter = 0;

/** Runs `fn` with the cookie header written to a private temp file, removed afterwards. */
export async function withCookieFile<T>(cookie: string, fn: (path: string) => Promise<T>): Promise<T> {
  cookieFileCounter += 1;
  const path = join(tmpdir(), `misonos-ytdlp-cookies-${process.pid}-${cookieFileCounter}.txt`);
  await writeFile(path, netscapeCookieFile(cookie), { mode: 0o600 });
  try {
    return await fn(path);
  } finally {
    await rm(path, { force: true });
  }
}

let activeRuns = 0;
const waitingRuns: (() => void)[] = [];

async function withRunSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRuns < MAX_CONCURRENT_RUNS) activeRuns += 1;
  else await new Promise<void>((resolve) => waitingRuns.push(resolve)); // the slot is handed over
  try {
    return await fn();
  } finally {
    const next = waitingRuns.shift();
    if (next) next();
    else activeRuns -= 1;
  }
}

function runYtDlp(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new YtDlpMissingError());
      if (error.killed) return reject(new Error(`yt-dlp took longer than ${timeoutMs / 1000}s`));
      reject(new Error(`yt-dlp: ${lastErrorLine(stderr) ?? error.message}`));
    });
  });
}

function lastErrorLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = lines.filter((line) => line.startsWith("ERROR:")).pop() ?? lines.pop();
  return error?.replace(/^ERROR:\s*/, "");
}

// ---- keeping yt-dlp current ------------------------------------------------------

const AUTO_UPDATE = process.env.YTDLP_AUTO_UPDATE === "1";
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
// After a failed resolve, update at most this often (the release may not exist yet).
const UPDATE_ON_FAILURE_GAP_MS = 6 * 60 * 60 * 1000;
let lastUpdateAt = 0;

/** Logs the yt-dlp version and, with YTDLP_AUTO_UPDATE=1, keeps it updated daily. */
export function startYtDlpMaintenance(): void {
  runYtDlp(["--version"], 15_000).then(
    (version) => console.log(`[ytmusic] yt-dlp ${version.trim()}${AUTO_UPDATE ? " (auto-update on)" : ""}`),
    (error: unknown) => console.warn(`[ytmusic] ${error instanceof Error ? error.message : String(error)}`)
  );
  if (!AUTO_UPDATE) return;
  setTimeout(() => void updateYtDlp("startup"), 60_000).unref();
  setInterval(() => void updateYtDlp("daily"), UPDATE_EVERY_MS).unref();
}

/** A resolve failed everywhere: the usual cause is a yt-dlp that YouTube has outrun. */
export function requestYtDlpUpdate(): void {
  if (!AUTO_UPDATE || Date.now() - lastUpdateAt < UPDATE_ON_FAILURE_GAP_MS) return;
  void updateYtDlp("after a failed resolve");
}

async function updateYtDlp(reason: string): Promise<void> {
  lastUpdateAt = Date.now();
  try {
    const output = await runYtDlp(["--ignore-config", "--update"], 120_000);
    const summary = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    console.log(`[ytmusic] yt-dlp update (${reason}): ${summary ?? "done"}`);
  } catch (error) {
    console.warn(`[ytmusic] yt-dlp update (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
