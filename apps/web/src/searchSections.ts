import type { SourceBrowseItem } from "@misonos/sonos-protocol";

// The sections a source's search results come in (a "section" row, then its items),
// and the order Settings → Search results order puts them in. Only sources whose
// search returns sections are listed; YouTube Music searches one type at a time.

export interface SearchSection {
  key: string;
  title: string;
}

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
  if (!order?.length) return sections;
  const named = order.flatMap((key) => sections.filter((section) => section.key === key));
  return [...named, ...sections.filter((section) => !named.includes(section))];
}

/** Results with their sections moved into `order`; anything before the first section stays on top. */
export function orderSearchSections(items: SourceBrowseItem[], order: string[] | undefined): SourceBrowseItem[] {
  if (!order?.length) return items;
  const head: SourceBrowseItem[] = [];
  const groups: SourceBrowseItem[][] = [];
  for (const item of items) {
    if (item.kind === "section") groups.push([item]);
    else if (groups.length > 0) groups[groups.length - 1].push(item);
    else head.push(item);
  }
  if (groups.length < 2) return items;
  const rank = (group: SourceBrowseItem[]) => {
    const index = order.indexOf(sectionKeyOf(group[0]));
    return index < 0 ? order.length : index;
  };
  const sorted = groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index);
  return [...head, ...sorted.flatMap(({ group }) => group)];
}
