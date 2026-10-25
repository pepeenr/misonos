import { homedir } from "node:os";
import path from "node:path";

export interface NavidromeConfig {
  host: string;
  port: number;
  serviceName: string;
  // The Navidrome (or any Subsonic-compatible) server, e.g. http://127.0.0.1:4533.
  serverUrl?: string;
  username?: string;
  password?: string;
  // Base URL this service advertises for its own /stream and /art endpoints. The
  // speakers fetch cover art from it directly, so under Docker it must be the
  // host's LAN address. Defaults to the Host header the bridge called us on.
  publicUrl?: string;
  // Target codec + bitrate when a file isn't natively playable on Sonos (Opus, …).
  transcodeFormat: string;
  maxBitRate: number;
  // Where a login saved from Settings is kept. It wins over the env vars above.
  loginPath: string;
}

// Either a password (a fresh salt per request) or a saved login's fixed salt and
// token = md5(password + salt), so the password itself never has to be stored.
export type NavidromeServer = { serverUrl: string; username: string } & ({ password: string } | { salt: string; token: string });

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NavidromeConfig {
  return {
    host: env.MISONOS_NAVIDROME_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_NAVIDROME_PORT ?? "4325", 10),
    serviceName: env.MISONOS_NAVIDROME_NAME ?? "Navidrome",
    serverUrl: baseUrl(env.MISONOS_NAVIDROME_SERVER_URL),
    username: env.MISONOS_NAVIDROME_USER || undefined,
    password: env.MISONOS_NAVIDROME_PASSWORD || undefined,
    publicUrl: baseUrl(env.MISONOS_NAVIDROME_PUBLIC_URL),
    transcodeFormat: env.MISONOS_NAVIDROME_TRANSCODE_FORMAT || "mp3",
    maxBitRate: Number.parseInt(env.MISONOS_NAVIDROME_MAX_BITRATE || "320", 10),
    loginPath: env.MISONOS_NAVIDROME_LOGIN_PATH || path.join(homedir(), ".misonos", "navidrome-login.json")
  };
}

// The source stays up but unlisted (/info → 503) until all three are set, so a
// stack that doesn't use Navidrome can still run this service harmlessly.
export function serverFromConfig(config: NavidromeConfig): NavidromeServer | undefined {
  if (!config.serverUrl || !config.username || !config.password) return undefined;
  return { serverUrl: config.serverUrl, username: config.username, password: config.password };
}

// Accept only an absolute http(s) URL with a host — compose interpolation of an
// unset variable yields things like "http://:4325", which must count as unset.
export function baseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
    return raw.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
