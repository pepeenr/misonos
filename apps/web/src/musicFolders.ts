// Which of a source's top-level folders are open in Music, per source and Spotify login
// (the root's browse key → folder ids), on this device.
export const MUSIC_OPEN_FOLDERS_KEY = "misonos.music.openFolders";

export function readOpenFolders(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MUSIC_OPEN_FOLDERS_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string[]> : {};
  } catch {
    return {};
  }
}

export function saveOpenFolders(value: Record<string, string[]>): void {
  try {
    localStorage.setItem(MUSIC_OPEN_FOLDERS_KEY, JSON.stringify(value));
  } catch {
    // Private mode: which folders are open just isn't remembered.
  }
}
