import type { SourceBrowseItem } from "@misonos/sonos-protocol";

// The orders Settings → Order in Music sets, per source and Spotify login: Music's
// top-level folders, and the sections a search's results come in (a "section" row,
// then its items). Only sources whose search returns sections have a search order;
// YouTube Music searches one type at a time.

/** Something to order: a search section, or a top-level folder (its id). */
export interface OrderEntry {
  key: string;
  title: string;
}
export type SearchSection = OrderEntry;

const SONGS = { key: "songs", title: "Songs" };
const ARTISTS = { key: "artists", title: "Artists" };
const ALBUMS = { key: "albums", title: "Albums" };
const PLAYLISTS = { key: "playlists", title: "Playlists" };

/** Each source's sections, in the order the source sends them. */
export const SEARCH_SECTIONS: Record<string, SearchSection[]> = {
  spotify: [SONGS, ARTISTS, ALBUMS, PLAYLISTS],
  navidrome: [ARTISTS, ALBUMS, SONGS]
};

/** Where a source's order is kept: the source, or one Spotify login of it. */
export function orderKey(sourceId: string, profileKey?: string): string {
  return profileKey ? `${sourceId}|${profileKey}` : sourceId;
}

/** The saved order for a source (or login); a login without one of its own uses the source's. */
export function savedOrder(orders: Record<string, string[]>, sourceId: string, profileKey?: string): string[] | undefined {
  return orders[orderKey(sourceId, profileKey)] ?? (profileKey ? orders[sourceId] : undefined);
}

/** "section:songs" → "songs"; a numbered "section:Songs:3" → "songs". */
export function sectionKeyOf(item: SourceBrowseItem): string {
  return item.id.replace(/^section:/, "").replace(/:\d+$/, "").trim().toLowerCase();
}

/** A source's sections in the saved order; ones the order doesn't name keep the source's order, after it. */
export function sectionsInOrder(sections: SearchSection[], order: string[] | undefined): SearchSection[] {
  return inSavedOrder(sections, order, (section) => section.key);
}

/** A list cut at its "section" rows: what comes before the first one, then each section and its items. */
export interface SplitList {
  head: SourceBrowseItem[];
  sections: { section: SourceBrowseItem; items: SourceBrowseItem[] }[];
}

export function splitSections(items: SourceBrowseItem[]): SplitList {
  const result: SplitList = { head: [], sections: [] };
  for (const item of items) {
    if (item.kind === "section") result.sections.push({ section: item, items: [] });
    else if (result.sections.length > 0) result.sections[result.sections.length - 1].items.push(item);
    else result.head.push(item);
  }
  return result;
}

/** Results with their sections moved into `order`; anything before the first section stays on top. */
export function orderSearchSections(items: SourceBrowseItem[], order: string[] | undefined): SourceBrowseItem[] {
  if (!order?.length) return items;
  const { head, sections } = splitSections(items);
  if (sections.length < 2) return items;
  const sorted = inSavedOrder(sections, order, ({ section }) => sectionKeyOf(section));
  return [...head, ...sorted.flatMap(({ section, items: rows }) => [section, ...rows])];
}

/** Entries in the saved order (by key); ones it doesn't name keep their own order, after it. */
export function inSavedOrder<T>(entries: T[], order: string[] | undefined, keyOf: (entry: T) => string): T[] {
  if (!order?.length) return entries;
  const rank = (entry: T) => {
    const index = order.indexOf(keyOf(entry));
    return index < 0 ? order.length : index;
  };
  const sorted = entries.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index);
  return sorted.some(({ index }, position) => index !== position) ? sorted.map(({ entry }) => entry) : entries;
}

/** Music's top-level folders in the saved order (by folder id). */
export function orderFolders(items: SourceBrowseItem[], order: string[] | undefined): SourceBrowseItem[] {
  return inSavedOrder(items, order, (item) => item.id);
}
