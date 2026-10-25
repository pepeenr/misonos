import { homedir } from "node:os";
import path from "node:path";

export interface SpotifyConfig {
  host: string;
  port: number;
  serviceName: string;
  // Client ID of your own app on developer.spotify.com. Sign-in uses the PKCE flow,
  // so there is no client secret to configure or keep.
  clientId?: string;
  // A fixed OAuth redirect URI. Unset, the web app sends the one for the address it
  // was opened on. Either way it must be listed on the Spotify app.
  redirectUri?: string;
  // Where the refresh token persists across restarts.
  tokenPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpotifyConfig {
  return {
    host: env.MISONOS_SPOTIFY_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_SPOTIFY_PORT ?? "4326", 10),
    serviceName: env.MISONOS_SPOTIFY_NAME ?? "Spotify",
    clientId: env.MISONOS_SPOTIFY_CLIENT_ID?.trim() || undefined,
    redirectUri: redirectUri(env.MISONOS_SPOTIFY_REDIRECT_URI),
    tokenPath: env.MISONOS_SPOTIFY_TOKEN_PATH || path.join(homedir(), ".misonos", "spotify-token.json")
  };
}

// An absolute http(s) URL ending in the callback route, or undefined. Spotify checks
// the URI against the app's list anyway; this only catches typos and compose
// interpolation of an unset variable (an empty string).
export function redirectUri(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
    if (!url.pathname.endsWith("/auth/callback")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
