import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NavidromeBrowser } from "./browse.js";
import { baseUrl, serverFromConfig, type NavidromeConfig } from "./config.js";
import { encodeId } from "./ids.js";
import { clearSavedLogin, serverFromLogin, writeSavedLogin, type SavedLogin } from "./login.js";
import { mp3Bitrate } from "./mp3.js";
import { exactly, planStream, type SizedResponse, type StreamPlan } from "./stream.js";
import { SubsonicClient, SubsonicError, subsonicToken, type SubsonicSong } from "./subsonic.js";

const SONG_CACHE_TTL_MS = 10 * 60 * 1000;
const SONG_CACHE_MAX = 500;
// How much of a transcode to read while looking for its first MP3 frame.
const PROBE_LIMIT = 64 * 1024;
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

export function createServer(config: NavidromeConfig, savedLogin?: SavedLogin): http.Server {
  const envServer = serverFromConfig(config);
  let login = savedLogin;
  let connection: { api: SubsonicClient; browser: NavidromeBrowser } | undefined;
  // Sonos issues several requests per track (HEAD, ranges); resolve each song once.
  const songs = new Map<string, { song: SubsonicSong; expires: number }>();

  const lookupSong = async (client: SubsonicClient, id: string): Promise<SubsonicSong> => {
    const now = Date.now();
    const hit = songs.get(id);
    if (hit && hit.expires > now) return hit.song;
    const song = await client.song(id);
    if (songs.size >= SONG_CACHE_MAX) songs.clear();
    songs.set(id, { song, expires: now + SONG_CACHE_TTL_MS });
    return song;
  };
  // Transcode bitrates read off the stream itself, so later seeks map bytes to time
  // with the real figure even where the prediction from the song's bitrate is off.
  const bitrates = new Map<string, number>();

  // A login saved from Settings wins; the env vars are the fallback; with neither
  // the source stays hidden.
  const connect = () => {
    const server = login ? serverFromLogin(login) : envServer;
    const api = server ? new SubsonicClient(server) : undefined;
    connection = api ? { api, browser: new NavidromeBrowser(api, config) } : undefined;
    songs.clear();
    bitrates.clear();
  };
  connect();

  // What Settings shows. Never includes the password or token.
  const loginStatus = () => {
    const active = login ?? envServer;
    return {
      source: login ? "saved" : envServer ? "env" : "none",
      serverUrl: active?.serverUrl,
      username: active?.username,
      envConfigured: Boolean(envServer)
    };
  };

  // Save a login only once the server accepts it.
  const saveLogin = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const body = await readJson<{ serverUrl?: unknown; username?: unknown; password?: unknown }>(request);
    const serverUrl = typeof body.serverUrl === "string" ? baseUrl(body.serverUrl.trim()) : undefined;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!serverUrl) return sendJson(response, 400, { error: "Enter the server URL, e.g. http://127.0.0.1:4533" });
    if (!username || !password) return sendJson(response, 400, { error: "Enter a username and password" });
    const candidate: SavedLogin = { serverUrl, username, ...subsonicToken(password), savedAt: new Date().toISOString() };
    try {
      await new SubsonicClient(serverFromLogin(candidate)).ping();
    } catch (error) {
      const reason = error instanceof SubsonicError
        ? error.code === 40 ? "Wrong username or password" : error.message
        : `No Subsonic server answered at ${serverUrl} (${errorMessage(error)})`;
      return sendJson(response, 400, { error: reason });
    }
    await writeSavedLogin(config.loginPath, candidate);
    login = candidate;
    connect();
    console.log(`[navidrome-smapi] saved login: ${serverUrl} as ${username}`);
    sendJson(response, 200, loginStatus());
  };

  // A CBR MP3 transcode, sized by `plan`. HEAD and unsatisfiable ranges are answered
  // without starting a transcode.
  const serveTranscode = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    client: SubsonicClient,
    song: SubsonicSong,
    plan: StreamPlan & { sized: SizedResponse }
  ): Promise<void> => {
    let sized = plan.sized;
    if (sized.status === 416) {
      response.writeHead(416, { "content-range": `bytes */${sized.total}` });
      response.end();
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(sized.status, sizedHeaders(sized));
      response.end();
      return;
    }
    const upstream = await fetchUpstream(request, response, client.url("stream", plan.params), {});
    if (!upstream?.body) return;
    const reader = upstream.body.getReader();
    const { buffered, kbps } = await probeBitrate(reader);
    if (buffered.length === 0) return sendJson(response, 502, { error: "Navidrome: the transcode came back empty" });
    if (kbps) {
      if (bitrates.size >= SONG_CACHE_MAX) bitrates.clear();
      bitrates.set(song.id, kbps);
      // Re-size with the real bitrate when that doesn't change what was asked of the server.
      const replanned = planStream(song, { ...config, kbps }, request.headers.range);
      if (replanned.sized?.status === sized.status && replanned.params.timeOffset === plan.params.timeOffset) {
        sized = replanned.sized;
      }
    }
    response.writeHead(sized.status, sizedHeaders(sized));
    const body = Readable.from(exactly(upstreamChunks(reader, buffered), sized.end - sized.start + 1), { objectMode: false });
    await pipeline(body, response).catch(() => undefined);
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const base = config.publicUrl ?? url.origin;

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName, configured: Boolean(connection) });
      }
      if (request.method === "GET" && url.pathname === "/config") {
        return sendJson(response, 200, loginStatus());
      }
      if (request.method === "POST" && url.pathname === "/config") {
        return await saveLogin(request, response);
      }
      if (request.method === "POST" && url.pathname === "/config/clear") {
        await clearSavedLogin(config.loginPath);
        login = undefined;
        connect();
        console.log("[navidrome-smapi] saved login cleared");
        return sendJson(response, 200, loginStatus());
      }
      // Unconfigured, the bridge's /info probe fails and the source stays hidden.
      if (!connection) {
        return sendJson(response, 503, {
          error: "Navidrome is not configured: log in under Settings → Custom Music Services, or set MISONOS_NAVIDROME_SERVER_URL, MISONOS_NAVIDROME_USER and MISONOS_NAVIDROME_PASSWORD"
        });
      }
      // Pinned per request, so a login change mid-request can't mix servers.
      const { api, browser } = connection;
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "navidrome",
          name: config.serviceName,
          description: "Your music library on Navidrome",
          rootId: encodeId({ kind: "root" }),
          capabilities: ["search"]
        });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const id = url.searchParams.get("id") ?? encodeId({ kind: "root" });
        try {
          return sendJson(response, 200, await browser.browse(id, base));
        } catch (error) {
          return sendJson(response, 400, { error: errorMessage(error) });
        }
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        return sendJson(response, 200, await browser.search(query, base));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        try {
          return sendJson(response, 200, await browser.track(id, base));
        } catch (error) {
          return sendJson(response, 502, { error: errorMessage(error) });
        }
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/stream") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const song = await lookupSong(api, id);
        const plan = planStream(song, { ...config, kbps: bitrates.get(song.id) }, request.headers.range);
        if (plan.sized) return await serveTranscode(request, response, api, song, { ...plan, sized: plan.sized });
        const headers: Record<string, string> = {};
        if (plan.forwardRange && request.headers.range) headers.range = request.headers.range;
        return await relay(request, response, api.url("stream", plan.params), headers, (out, status) => {
          // Proxies can drop a full response's Content-Length (Cloudflare does); a raw file's size is known.
          if (plan.forwardRange && status === 200 && !out["content-length"] && song.size) out["content-length"] = String(song.size);
        });
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/art") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        const size = url.searchParams.get("size") ?? undefined;
        return await relay(request, response, api.url("getCoverArt", { id, size }), {}, (out) => {
          out["cache-control"] = "public, max-age=86400";
        });
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 502, { error: errorMessage(error) });
    }
  });
}

// Pipe a Subsonic binary endpoint (stream / cover art) to the client. `adjust` may
// rewrite the outgoing headers.
async function relay(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamUrl: URL,
  headers: Record<string, string>,
  adjust: (out: Record<string, string>, status: number) => void
): Promise<void> {
  const upstream = await fetchUpstream(request, response, upstreamUrl, headers);
  if (!upstream) return;
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  adjust(out, upstream.status);
  response.writeHead(upstream.status, out);
  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("error", () => response.destroy());
  body.pipe(response);
}

// Fetch a Subsonic binary endpoint, aborted when the client goes away. On an error the
// client gets it as JSON and the result is undefined.
async function fetchUpstream(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamUrl: URL,
  headers: Record<string, string>
): Promise<Response | undefined> {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  const upstream = await fetch(upstreamUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    signal: controller.signal
  });
  const contentType = upstream.headers.get("content-type") ?? "";
  // Subsonic reports errors (bad id, auth) as a JSON/XML body, not an HTTP status.
  if (!upstream.ok || /json|xml/i.test(contentType)) {
    const detail = /json/i.test(contentType) ? subsonicError(await upstream.text()) : `HTTP ${upstream.status}`;
    sendJson(response, upstream.ok ? 502 : upstream.status, { error: `Navidrome: ${detail}` });
    return undefined;
  }
  return upstream;
}

// Read the start of a transcode until its first MP3 frame shows the bitrate.
async function probeBitrate(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ buffered: Uint8Array[]; kbps?: number }> {
  const buffered: Uint8Array[] = [];
  let size = 0;
  while (size < PROBE_LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered.push(value);
    size += value.length;
    const kbps = mp3Bitrate(Buffer.concat(buffered));
    if (kbps) return { buffered, kbps };
  }
  return { buffered };
}

// The probed chunks, then the rest of the upstream body. Finishing early (the response
// has its bytes, or the client left) cancels the download.
async function* upstreamChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[]
): AsyncGenerator<Uint8Array> {
  try {
    yield* buffered;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function sizedHeaders(sized: { status: 200 | 206; start: number; end: number; total: number }): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "content-length": String(sized.end - sized.start + 1)
  };
  if (sized.status === 206) headers["content-range"] = `bytes ${sized.start}-${sized.end}/${sized.total}`;
  return headers;
}

function subsonicError(text: string): string {
  try {
    const body = JSON.parse(text) as { "subsonic-response"?: { error?: { message?: string } } };
    return body["subsonic-response"]?.error?.message ?? "request failed";
  } catch {
    return "request failed";
  }
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Internal error";
}
