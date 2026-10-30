import type { SonosGroup } from "@misonos/sonos-protocol";

// The room the web app has selected, shared by every device through the store: the
// sorted uuids of the group's visible rooms (membershipKey in apps/web/src/App.tsx).
// Tools that can't know Sonos group ids, which change on every regroup, act on this
// room: the keyboard's media keys (scripts/windows/misonos-media-keys.ahk).
export const SELECTED_GROUP_PREF = "lastGroupKey";

/** The selected group: an exact match, else the group holding most of its rooms, else the first. */
export function pickSelectedGroup(groups: SonosGroup[], key: string | undefined): SonosGroup | undefined {
  const wanted = new Set((key ?? "").split("|").filter(Boolean));
  let best: SonosGroup | undefined;
  let bestScore = -1;
  for (const group of groups) {
    const rooms = group.zones.filter((zone) => zone.visible).map((zone) => zone.uuid);
    const shared = rooms.filter((uuid) => wanted.has(uuid)).length;
    const exact = wanted.size > 0 && shared === wanted.size && rooms.length === wanted.size;
    const score = exact ? Number.MAX_SAFE_INTEGER : shared;
    if (score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best;
}

/** One step of the volume keys, kept under the app's volume cap (it never pulls a louder room down). */
export function stepVolume(current: number, delta: number, cap = 100): number {
  const target = current + delta;
  if (delta > 0) return Math.min(target, Math.max(current, cap), 100);
  return Math.max(0, target);
}
