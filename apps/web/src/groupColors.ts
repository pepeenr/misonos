import { useSyncExternalStore } from "react";
import type { GroupColorChoices } from "./groupPalette.js";
import { GROUP_COLORS_PREF, loadPref, readLocalPref, setPref } from "./prefs.js";

// The group colors picked in the Group Editor, shared by every view that shows group
// colors (the room menu, Music, Library, the editor). Read from the bridge once per
// page load; until then the local cache stands in.
let choices: GroupColorChoices = readLocalPref(GROUP_COLORS_PREF) ?? {};
const listeners = new Set<() => void>();
let requested = false;

function update(next: GroupColorChoices): void {
  choices = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    void loadPref(GROUP_COLORS_PREF).then((value) => { if (value) update(value); });
  }
  return () => { listeners.delete(listener); };
}

export function useGroupColors(): GroupColorChoices {
  return useSyncExternalStore(subscribe, () => choices);
}

/** Give the group led by `coordinatorId` a palette color, or null to go back to automatic. */
export function setGroupColor(coordinatorId: string, name: string | null): void {
  const next = { ...choices };
  if (name) next[coordinatorId] = name;
  else delete next[coordinatorId];
  update(next);
  setPref(GROUP_COLORS_PREF, next);
}
