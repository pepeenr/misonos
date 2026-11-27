import type http from "node:http";
import { Readable } from "node:stream";
import { fetchTrack } from "./sources.js";
import { meterStream } from "./meter.js";

interface CachedTrack {
  url: string;
  contentType?: string;
  expires: number;
}

const TRACK_CACHE_TTL_MS = 5 * 60 * 1000;
const trackUrlCache = new Map<string, CachedTrack>();

const FETCH_HEADERS_PASSTHROUGH = new Set(["range"]);
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const RESPONSE_HEADERS_PASSTHROUGH = new Set([
  "content-type",
  "content-length",
  "content-range",
  "cache-control",
  "etag",
  "last-modified"
]);

export async function proxyStream(
  sourceId: string,
  trackId: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const peer = request.socket.remoteAddress ?? "?";
  const range = request.headers.range ?? "-";
  console.log(`[stream-proxy] ${request.method} ${sourceId}/${trackId} from ${peer} range=${range}`);
  let cached: CachedTrack & { reused: boolean };
  try {
    cached = await getCachedTrack(sourceId, trackId);
  } catch (error) {
    console.warn(`[stream-proxy] track resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    return fail(response, 502, error instanceof Error ? error.message : "Failed to resolve track");
  }
  // Spotify URIs play through Sonos's own Spotify link; there's nothing to proxy.
  if (!/^https?:\/\//i.test(cached.url)) {
    return fail(response, 409, "This track plays only on Sonos speakers");
  }

  const isHead = request.method === "HEAD";
  let upstream: Response;
  try {
    upstream = await openUpstream(cached.url, request);
    // A stream URL found earlier can stop working while it's kept (a YouTube URL is
    // bound to the public IP it was found from): find the track's stream again, once,
    // rather than fail a song that the speaker is partway through.
    if (!upstream.ok && upstream.status !== 416) {
      trackUrlCache.delete(cacheKey(sourceId, trackId));
      if (cached.reused) {
        await upstream.body?.cancel().catch(() => undefined);
        console.warn(`[stream-proxy] kept stream URL answered ${upstream.status}; looking ${sourceId}/${trackId} up again`);
        cached = await getCachedTrack(sourceId, trackId);
        upstream = await openUpstream(cached.url, request);
        if (!upstream.ok && upstream.status !== 416) trackUrlCache.delete(cacheKey(sourceId, trackId));
      }
    }
    console.log(`[stream-proxy] upstream ${upstream.status} ${upstream.headers.get("content-type") ?? ""} len=${upstream.headers.get("content-length") ?? "?"}`);
  } catch (error) {
    console.warn(`[stream-proxy] upstream fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return fail(response, 502, error instanceof Error ? error.message : "Upstream fetch failed");
  }

  // Allow the browser's local player to read this stream cross-origin: when the
  // controller is pointed at another location's backend, the <audio> element loads it
  // with crossOrigin="anonymous" so Web Audio (the VU meter) can tap it without muting.
  const downstreamHeaders: Record<string, string> = { "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
  for (const [key, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADERS_PASSTHROUGH.has(key.toLowerCase())) downstreamHeaders[normalizeHeader(key)] = value;
  }
  if (!downstreamHeaders["Content-Type"]) {
    downstreamHeaders["Content-Type"] = cached.contentType ?? "audio/mpeg";
  }

  response.writeHead(upstream.status, downstreamHeaders);

  if (isHead || !upstream.body) {
    response.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  let aborted = false;
  const cleanup = () => {
    if (aborted) return;
    aborted = true;
    if (!nodeStream.destroyed) nodeStream.destroy();
  };
  nodeStream.on("error", (error) => {
    console.warn(`[stream-proxy] upstream stream error for ${sourceId}/${trackId}: ${error.message}`);
    // Drop the connection rather than end it: the speaker was promised the whole length,
    // so a clean end leaves it waiting for the rest. A dropped one it asks for again
    // from where it got to.
    if (!response.destroyed) response.destroy();
  });
  request.on("close", cleanup);
  response.on("close", cleanup);
  // Tee the same bytes into the VU meter (decoded server-side) so the web meter
  // never has to pull a competing second copy. Audio (not HEAD) only.
  if (!isHead) meterStream(sourceId, trackId, nodeStream, request.headers.range);
  nodeStream.pipe(response);
}

// The upstream request for a stream URL, carrying the speaker's Range.
function openUpstream(url: string, request: http.IncomingMessage): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": BROWSER_USER_AGENT
  };
  for (const [key, value] of Object.entries(request.headers)) {
    if (!FETCH_HEADERS_PASSTHROUGH.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value === "string") headers[key] = value;
  }
  if (/googlevideo|youtube/i.test(url)) {
    headers.origin = "https://music.youtube.com";
    headers.referer = "https://music.youtube.com/";
  }
  return fetch(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow"
  });
}

function cacheKey(sourceId: string, trackId: string): string {
  return `${sourceId}\u0000${trackId}`;
}

// A track's stream URL, found by its source or kept from a few minutes ago (`reused`).
async function getCachedTrack(sourceId: string, trackId: string): Promise<CachedTrack & { reused: boolean }> {
  const key = cacheKey(sourceId, trackId);
  const now = Date.now();
  const cached = trackUrlCache.get(key);
  if (cached && cached.expires > now) return { ...cached, reused: true };
  const info = await fetchTrack(sourceId, trackId);
  const entry: CachedTrack = {
    url: info.url,
    contentType: info.mimeType,
    expires: now + TRACK_CACHE_TTL_MS
  };
  trackUrlCache.set(key, entry);
  return { ...entry, reused: false };
}

function fail(response: http.ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  const body = JSON.stringify({ error: message });
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function normalizeHeader(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}
