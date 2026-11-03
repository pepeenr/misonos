import { homedir } from "node:os";
import path from "node:path";

export interface BridgeConfig {
  host: string;
  port: number;
  callbackHost?: string;
  discoveryTimeoutMs: number;
  pollIntervalMs: number;
  manualSpeakerIps: string[];
  dbPath: string;
  /** Where Downtify answers, for getting songs from YouTube; unset hides the feature. */
  downtify?: { url: string; host?: string };
  /** The Navidrome playlist YouTube songs are added to. */
  youtubePlaylist: string;
}

export function loadConfig(env = process.env): BridgeConfig {
  return {
    host: env.MISONOS_BRIDGE_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.MISONOS_BRIDGE_PORT ?? "4317", 10),
    callbackHost: env.MISONOS_CALLBACK_HOST,
    discoveryTimeoutMs: Number.parseInt(env.MISONOS_DISCOVERY_TIMEOUT_MS ?? "2500", 10),
    pollIntervalMs: Number.parseInt(env.MISONOS_POLL_INTERVAL_MS ?? "2500", 10),
    manualSpeakerIps: (env.MISONOS_SPEAKER_IPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    dbPath: env.MISONOS_BRIDGE_DB ?? path.join(homedir(), ".misonos", "misonos.db"),
    // The Host header is for reaching Downtify through a reverse proxy on the same box
    // (Traefik on 127.0.0.1 routes by host name), past anything in front of its domain.
    downtify: env.MISONOS_DOWNTIFY_URL
      ? { url: env.MISONOS_DOWNTIFY_URL, host: env.MISONOS_DOWNTIFY_HOST || undefined }
      : undefined,
    youtubePlaylist: env.MISONOS_YOUTUBE_PLAYLIST || "YouTube"
  };
}
