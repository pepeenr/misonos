// What's open or folded in Music, on this device. Both are kept per list: a source and
// Spotify login's root, one of its folders, or its search results (the list's browse key).
// Folders are closed until opened; a list's sections are open until folded.

/** A source's top-level folders that are open: the root's browse key → folder ids. */
export const MUSIC_OPEN_FOLDERS_KEY = "misonos.music.openFolders";
/** Sections that are folded (a search's Songs, YouTube Music's shelves): a list's browse key → section keys. */
export const MUSIC_FOLDED_SECTIONS_KEY = "misonos.music.foldedSections";

type Lists = Record<string, string[]>;

function readLists(key: string): Lists {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" ? value as Lists : {};
  } catch {
    return {};
  }
}

function saveLists(key: string, value: Lists): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: what's open just isn't remembered.
  }
}

export const readOpenFolders = (): Lists => readLists(MUSIC_OPEN_FOLDERS_KEY);
export const saveOpenFolders = (value: Lists): void => saveLists(MUSIC_OPEN_FOLDERS_KEY, value);
export const readFoldedSections = (): Lists => readLists(MUSIC_FOLDED_SECTIONS_KEY);
export const saveFoldedSections = (value: Lists): void => saveLists(MUSIC_FOLDED_SECTIONS_KEY, value);

/** `entry` added to the list's entries, or taken out if it's there; a list left empty is dropped. */
export function toggleEntry(lists: Lists, list: string, entry: string): Lists {
  const current = lists[list] ?? [];
  const next = current.includes(entry) ? current.filter((value) => value !== entry) : [...current, entry];
  const result = { ...lists, [list]: next };
  if (next.length === 0) delete result[list];
  return result;
}
