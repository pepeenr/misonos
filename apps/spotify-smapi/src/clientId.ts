import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// The Client ID of the user's Spotify app, saved from MiSonos Settings. It isn't a
// secret (PKCE sign-in sends it in the browser), so Settings may show it back.
export interface SavedClientId {
  clientId: string;
  savedAt: string;
}

// Spotify Client IDs are 32 hex characters, as the dashboard shows them.
export function parseClientId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

export async function readSavedClientId(file: string): Promise<SavedClientId | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as Partial<SavedClientId>;
    const clientId = parseClientId(value.clientId);
    if (!clientId) throw new Error("no client id");
    return { clientId, savedAt: value.savedAt ?? "" };
  } catch {
    console.warn(`[spotify-smapi] ignoring unreadable saved Client ID at ${file}`);
    return undefined;
  }
}

export async function writeSavedClientId(file: string, saved: SavedClientId): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(saved, null, 2));
}

export async function clearSavedClientId(file: string): Promise<void> {
  await rm(file, { force: true });
}
