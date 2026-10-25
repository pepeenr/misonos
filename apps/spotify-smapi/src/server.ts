import http from "node:http";
import type { SourceBrowseItem } from "@misonos/sonos-protocol";
import { SpotifyAuth, SpotifyAuthError } from "./auth.js";
import { SpotifyBrowser } from "./browse.js";
import { redirectUri, type SpotifyConfig } from "./config.js";
import { IdError } from "./ids.js";
import { SpotifyClient, SpotifyError, type SpotifyProfile } from "./spotify.js";

// Shown in place of the library until someone connects an account.
const SIGN_IN_NOTICE: SourceBrowseItem = {
  id: "section:sign-in",
  title: "Connect Spotify under Settings → Spotify to browse your library",
  kind: "section"
};

export function createServer(config: SpotifyConfig, fetchImpl: typeof fetch = fetch): http.Server {
  const auth = config.clientId ? new SpotifyAuth(config.clientId, config.tokenPath, fetchImpl) : undefined;
  const api = auth ? new SpotifyClient(auth, fetchImpl) : undefined;
  const browser = api ? new SpotifyBrowser(api) : undefined;

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName, configured: Boolean(auth) });
      }
      // Answered even unconfigured, so Settings can explain the setup.
      if (request.method === "GET" && url.pathname === "/auth/status") {
        if (!auth) return sendJson(response, 200, { configured: false, signedIn: false });
        return sendJson(response, 200, { configured: true, ...(await auth.status()), redirectUri: config.redirectUri ?? null });
      }
      // Unconfigured, the bridge's /info probe fails and the source stays hidden.
      if (!auth || !api || !browser) {
        return sendJson(response, 503, { error: "Spotify is not configured: set MISONOS_SPOTIFY_CLIENT_ID" });
      }
      if (request.method === "GET" && url.pathname === "/info") {
        return sendJson(response, 200, {
          id: "spotify",
          name: config.serviceName,
          description: "Your Spotify library, played by the Spotify account linked to Sonos",
          rootId: "root",
          // sonos-only: tracks play through Sonos's Spotify link, never as a stream.
          capabilities: ["search", "sonos-only"]
        });
      }
      if (request.method === "GET" && url.pathname === "/auth/login") {
        const target = config.redirectUri ?? redirectUri(url.searchParams.get("redirect_uri"));
        if (!target) return sendJson(response, 400, { error: "Missing or invalid redirect_uri" });
        return sendJson(response, 200, { url: auth.beginLogin(target) });
      }
      if (request.method === "GET" && url.pathname === "/auth/callback") {
        const denied = url.searchParams.get("error");
        if (denied) return sendJson(response, 400, { error: denied === "access_denied" ? "Spotify sign-in was cancelled" : `Spotify: ${denied}` });
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return sendJson(response, 400, { error: "Missing code or state" });
        await auth.completeLogin(code, state);
        const profile = await api.get<SpotifyProfile>("/me");
        await auth.setUser({ id: profile.id, displayName: profile.display_name ?? undefined });
        return sendJson(response, 200, await auth.status());
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        await auth.signOut();
        return sendJson(response, 200, { signedIn: false });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const id = url.searchParams.get("id") ?? "root";
        if (!(await auth.status()).signedIn) {
          if (id === "root") return sendJson(response, 200, { id, total: 1, items: [SIGN_IN_NOTICE] });
          return sendJson(response, 401, { error: "Not signed in to Spotify" });
        }
        return sendJson(response, 200, await browser.browse(id));
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        if (!(await auth.status()).signedIn) {
          return sendJson(response, 200, { id: `search:${query}`, total: 1, items: [SIGN_IN_NOTICE] });
        }
        return sendJson(response, 200, await browser.search(query));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await browser.track(id));
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, errorStatus(error), { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

function errorStatus(error: unknown): number {
  if (error instanceof SpotifyAuthError) return error.status;
  if (error instanceof SpotifyError) return error.status === 404 ? 404 : 502;
  if (error instanceof IdError) return 400;
  return 502;
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
