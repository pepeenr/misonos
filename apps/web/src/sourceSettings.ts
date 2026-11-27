import { useCallback, useEffect, useState } from "react";
import type { SourceDescriptor, SourceSetting } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";

/**
 * The running, switched-on sources (/api/sources), read once for the whole app (Music,
 * the playlists grid, Settings → Order in Music) and again whenever `sourcesVersion`
 * changes. `list` is null until the first answer; it keeps the last list on a failure.
 */
export function useSourceList(sourcesVersion: number) {
  const [list, setList] = useState<SourceDescriptor[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    bridgeApi.listSources()
      .then((next) => {
        if (cancelled) return;
        setList(next);
        setError("");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load sources");
      });
    return () => { cancelled = true; };
  }, [sourcesVersion]);

  return { list, error };
}

/** undefined while loading; null when the bridge couldn't list the sources. */
export type SourceSettings = SourceSetting[] | null | undefined;

/**
 * Every source the bridge knows, switched on or off, with its switch: for Settings,
 * where every section that belongs to a source follows its switch, and for Library,
 * which names a switched-off source's favorites. Read while `active` (one of those
 * screens is open), and again whenever `sourcesVersion` changes.
 */
export function useSourceSettings(active: boolean, sourcesVersion: number, onChanged: () => void) {
  const [settings, setSettings] = useState<SourceSettings>(undefined);
  const [toggleError, setToggleError] = useState("");

  const reload = useCallback(async () => {
    try {
      setSettings(await bridgeApi.sourceSettings());
    } catch {
      setSettings((current) => current ?? null);
    }
  }, []);

  useEffect(() => {
    if (active) void reload();
  }, [active, sourcesVersion, reload]);

  // Flip the switch right away, then settle on the bridge's answer (or roll back).
  const toggle = useCallback(async (sourceId: string, enabled: boolean) => {
    const flip = (on: boolean) =>
      setSettings((current) => current?.map((source) => (source.id === sourceId ? { ...source, enabled: on } : source)));
    setToggleError("");
    flip(enabled);
    try {
      setSettings(await bridgeApi.setSourceEnabled(sourceId, enabled));
      onChanged();
    } catch (err) {
      flip(!enabled);
      setToggleError(err instanceof Error ? err.message : "Failed");
    }
  }, [onChanged]);

  return { settings, toggleError, toggle };
}

/**
 * Whether a source's own Settings section shows: not while the sources are loading,
 * and not while the source is switched off. If they couldn't be read, it shows.
 */
export function sourceSectionShown(settings: SourceSettings, sourceId: string): boolean {
  if (settings === undefined) return false;
  return settings?.find((source) => source.id === sourceId)?.enabled !== false;
}

export function disabledSourceIds(settings: SourceSettings): Set<string> {
  return new Set((settings ?? []).filter((source) => !source.enabled).map((source) => source.id));
}
