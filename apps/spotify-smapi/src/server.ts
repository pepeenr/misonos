import { readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { SourceBrowseItem, SpotifyClientStatus } from "@misonos/sonos-protocol";
import { SpotifyAuth, SpotifyAuthError } from "./auth.js";
import { SpotifyBrowser } from "./browse.js";
import { clearSavedClientId, parseClientId, writeSavedClientId, type SavedClientId } from "./clientId.js";
import { redirectUri, type SpotifyConfig } from "./config.js";
import { IdError } from "./ids.js";
import { SpotifyClient, SpotifyError, type SpotifyProfile } from "./spotify.js";

// Shown in place of the library until someone connects an account.
const SIGN_IN_NOTICE: SourceBrowseItem = {
  id: "section:sign-in",
  title: "Connect Spotify under Settings → Spotify to browse your library",
  kind: "section"
};

// One signed-in Spotify account: its tokens, and the API and browse tree on them.
interface Account {
  auth: SpotifyAuth;
  api: SpotifyClient;
  browser: SpotifyBrowser;
}

interface Connection {
  clientId: string;
  /** The account connected under Settings → Spotify → "Your Spotify account". */
  main: Account;
  /** Accounts connected per Sonos Spotify login ("sid:sn"), so Mia's login browses Mia's library. */
  profiles: Map<string, Account>;
}

// A Sonos Spotify login, as "sid:sn" ("9:5").
const PROFILE_KEY = /^(\d{1,4}):(\d{1,4})$/;

export function profileKey(raw: string | null | undefined): string | undefined {
  return raw && PROFILE_KEY.test(raw) ? raw : undefined;
}

/** Where a login's own sign-in is kept: next to the main one, "spotify-token.9-5.json". */
export function profileTokenPath(tokenPath: string, key: string): string {
  const ext = path.extname(tokenPath);
  return path.join(path.dirname(tokenPath), `${path.basename(tokenPath, ext)}.${key.replace(":", "-")}${ext}`);
}

/** The logins with a sign-in of their own, read off the token files. */
async function savedProfileKeys(tokenPath: string): Promise<string[]> {
  const ext = path.extname(tokenPath);
  const base = path.basename(tokenPath, ext);
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d{1,4})-(\\d{1,4})${ext.replace(".", "\\.")}$`);
  try {
    return (await readdir(path.dirname(tokenPath)))
      .map((name) => pattern.exec(name))
      .filter((match): match is RegExpExecArray => !!match)
      .map((match) => `${match[1]}:${match[2]}`);
  } catch {
    return [];
  }
}

export function createServer(config: SpotifyConfig, saved?: SavedClientId, fetchImpl: typeof fetch = fetch): http.Server {
  let savedClientId = saved?.clientId;
  let connection: Connection | undefined;

  const account = (clientId: string, tokenPath: string): Account => {
    const auth = new SpotifyAuth(clientId, tokenPath, fetchImpl);
    const api = new SpotifyClient(auth, fetchImpl);
    return { auth, api, browser: new SpotifyBrowser(api) };
  };

  // A Client ID saved from Settings wins; the env var is the fallback; with neither
  // the source stays hidden.
  const connect = () => {
    const clientId = savedClientId ?? config.clientId;
    if (!clientId) {
      connection = undefined;
      return;
    }
    connection = { clientId, main: account(clientId, config.tokenPath), profiles: new Map() };
  };
  connect();

  /** A login's own account, made on first use (its token file may already exist). */
  const profileAccount = (active: Connection, key: string): Account => {
    let found = active.profiles.get(key);
    if (!found) {
      found = account(active.clientId, profileTokenPath(config.tokenPath, key));
      active.profiles.set(key, found);
    }
    return found;
  };

  /** The account to browse with for a login: its own sign-in, else the main one. */
  const browsingAccount = async (active: Connection, key: string | undefined): Promise<Account> => {
    if (key) {
      const own = profileAccount(active, key);
      if ((await own.auth.status()).signedIn) return own;
    }
    return active.main;
  };

  /** Any signed-in account, for lookups any account can make (a track, its artist). */
  const anyAccount = async (active: Connection): Promise<Account> => {
    if ((await active.main.auth.status()).signedIn) return active.main;
    for (const key of await savedProfileKeys(config.tokenPath)) {
      const own = profileAccount(active, key);
      if ((await own.auth.status()).signedIn) return own;
    }
    return active.main;
  };

  const profileStatuses = async (active: Connection) => {
    const profiles: Record<string, { id: string; displayName?: string }> = {};
    for (const key of await savedProfileKeys(config.tokenPath)) {
      const status = await profileAccount(active, key).auth.status();
      if (status.signedIn && status.user) profiles[key] = status.user;
    }
    return profiles;
  };

  const clientStatus = (): SpotifyClientStatus => ({
    source: savedClientId ? "saved" : config.clientId ? "env" : "none",
    clientId: savedClientId ?? config.clientId,
    envConfigured: Boolean(config.clientId)
  });

  // A sign-in belongs to the app that issued it, so switching apps signs out.
  const useClientId = async (next: string | undefined) => {
    const before = connection;
    savedClientId = next;
    if ((savedClientId ?? config.clientId) === before?.clientId) return;
    if (before) {
      await before.main.auth.signOut();
      for (const key of await savedProfileKeys(config.tokenPath)) await profileAccount(before, key).auth.signOut();
    }
    connect();
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: config.serviceName, configured: Boolean(connection) });
      }
      if (request.method === "GET" && url.pathname === "/config") {
        return sendJson(response, 200, clientStatus());
      }
      if (request.method === "POST" && url.pathname === "/config") {
        const body = await readJson<{ clientId?: unknown }>(request);
        const clientId = parseClientId(body.clientId);
        if (!clientId) {
          return sendJson(response, 400, { error: "That isn't a Client ID. It's 32 letters and digits, on your Spotify app's Settings page." });
        }
        await writeSavedClientId(config.clientIdPath, { clientId, savedAt: new Date().toISOString() });
        await useClientId(clientId);
        console.log("[spotify-smapi] saved Client ID from Settings");
        return sendJson(response, 200, clientStatus());
      }
      if (request.method === "POST" && url.pathname === "/config/clear") {
        await clearSavedClientId(config.clientIdPath);
        await useClientId(undefined);
        console.log("[spotify-smapi] saved Client ID cleared");
        return sendJson(response, 200, clientStatus());
      }
      // Pinned per request, so a Client ID change mid-request can't mix apps.
      const active = connection;
      // Answered even unconfigured, so Settings can explain the setup.
      if (request.method === "GET" && url.pathname === "/auth/status") {
        if (!active) return sendJson(response, 200, { configured: false, signedIn: false });
        return sendJson(response, 200, {
          configured: true,
          ...(await active.main.auth.status()),
          profiles: await profileStatuses(active),
          redirectUri: config.redirectUri ?? null
        });
      }
      // Unconfigured, the bridge's /info probe fails and the source stays hidden.
      if (!active) {
        return sendJson(response, 503, {
          error: "Spotify is not configured: add your Spotify app's Client ID under Settings → Spotify, or set MISONOS_SPOTIFY_CLIENT_ID"
        });
      }
      // A Sonos Spotify login ("9:5"): sign-in, sign-out, browse and search act on its own account.
      const profile = profileKey(url.searchParams.get("profile"));
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
        // Connecting a login's own account asks which account, since this browser is
        // likely signed in to Spotify as someone else already.
        const signingIn = profile ? profileAccount(active, profile) : active.main;
        return sendJson(response, 200, { url: signingIn.auth.beginLogin(target, { chooseAccount: Boolean(profile) }) });
      }
      if (request.method === "GET" && url.pathname === "/auth/callback") {
        const denied = url.searchParams.get("error");
        if (denied) return sendJson(response, 400, { error: denied === "access_denied" ? "Spotify sign-in was cancelled" : `Spotify: ${denied}` });
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return sendJson(response, 400, { error: "Missing code or state" });
        // The sign-in comes back to whichever account started it.
        const signingIn = [active.main, ...active.profiles.values()].find((candidate) => candidate.auth.hasPending(state)) ?? active.main;
        await signingIn.auth.completeLogin(code, state);
        const me = await signingIn.api.get<SpotifyProfile>("/me");
        await signingIn.auth.setUser({ id: me.id, displayName: me.display_name ?? undefined });
        return sendJson(response, 200, await signingIn.auth.status());
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        await (profile ? profileAccount(active, profile) : active.main).auth.signOut();
        return sendJson(response, 200, { signedIn: false });
      }
      if (request.method === "GET" && url.pathname === "/browse") {
        const id = url.searchParams.get("id") ?? "root";
        const { auth, browser } = await browsingAccount(active, profile);
        if (!(await auth.status()).signedIn) {
          if (id === "root") return sendJson(response, 200, { id, total: 1, items: [SIGN_IN_NOTICE] });
          return sendJson(response, 401, { error: "Not signed in to Spotify" });
        }
        return sendJson(response, 200, await browser.browse(id));
      }
      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) return sendJson(response, 400, { error: "Missing q" });
        const { auth, browser } = await browsingAccount(active, profile);
        if (!(await auth.status()).signedIn) {
          return sendJson(response, 200, { id: `search:${query}`, total: 1, items: [SIGN_IN_NOTICE] });
        }
        return sendJson(response, 200, await browser.search(query));
      }
      if (request.method === "GET" && url.pathname === "/track-artist") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await (await anyAccount(active)).browser.trackArtist(id));
      }
      if (request.method === "GET" && url.pathname === "/track") {
        const id = url.searchParams.get("id");
        if (!id) return sendJson(response, 400, { error: "Missing id" });
        return sendJson(response, 200, await (await anyAccount(active)).browser.track(id));
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
  if (error instanceof IdError || error instanceof SyntaxError) return 400;
  return 502;
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
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
