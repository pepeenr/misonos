import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { baseUrl, type NavidromeServer } from "./config.js";

// A login saved from MiSonos Settings. Only the Subsonic salt + token are kept,
// never the password: the token still opens the Subsonic API, but not the
// Navidrome web UI, and doesn't reveal a password that may be reused elsewhere.
export interface SavedLogin {
  serverUrl: string;
  username: string;
  salt: string;
  token: string;
  savedAt: string;
}

export async function readSavedLogin(file: string): Promise<SavedLogin | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as Partial<SavedLogin>;
    const serverUrl = baseUrl(value.serverUrl);
    if (!serverUrl || !value.username || !value.salt || !value.token) throw new Error("incomplete");
    return { serverUrl, username: value.username, salt: value.salt, token: value.token, savedAt: value.savedAt ?? "" };
  } catch {
    console.warn(`[navidrome-smapi] ignoring unreadable saved login at ${file}`);
    return undefined;
  }
}

export async function writeSavedLogin(file: string, login: SavedLogin): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(login, null, 2), { mode: 0o600 });
}

export async function clearSavedLogin(file: string): Promise<void> {
  await rm(file, { force: true });
}

export function serverFromLogin(login: SavedLogin): NavidromeServer {
  return { serverUrl: login.serverUrl, username: login.username, salt: login.salt, token: login.token };
}
