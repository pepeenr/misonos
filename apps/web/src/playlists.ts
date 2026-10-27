import { useEffect, useState } from "react";
import type { SourceBrowseItem, SourceDescriptor } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";

export interface PlaylistSource {
  source: SourceDescriptor;
  /** Browse id of the source's Playlists folder. */
  folderId: string;
}

// A source's playlists are the "Playlists" folder at its root (Navidrome's
// `playlists`, Spotify's `me:playlists`); the source contract has no field for it.
export function findPlaylistsFolder(items: SourceBrowseItem[]): SourceBrowseItem | undefined {
  return items.find((item) => item.kind === "container" && (/(^|:)playlists$/i.test(item.id) || item.title.trim().toLowerCase() === "playlists"));
}

/** The running sources that have a Playlists folder, in /api/sources order; null until known. */
export function usePlaylistSources(sourcesVersion: number): PlaylistSource[] | null {
  const [found, setFound] = useState<PlaylistSource[] | null>(null);
  const [authVersion, setAuthVersion] = useState(0);

  // Signing in or out of a source can add or remove its Playlists folder.
  useEffect(() => {
    const onAuthChange = () => setAuthVersion((version) => version + 1);
    window.addEventListener("misonos:source-auth-changed", onAuthChange);
    return () => window.removeEventListener("misonos:source-auth-changed", onAuthChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sources = await bridgeApi.listSources();
        const roots = await Promise.allSettled(sources.map((source) => bridgeApi.browseSource(source.id)));
        if (cancelled) return;
        setFound(sources.flatMap((source, index) => {
          const root = roots[index];
          const folder = root.status === "fulfilled" ? findPlaylistsFolder(root.value.items) : undefined;
          return folder ? [{ source, folderId: folder.id }] : [];
        }));
      } catch {
        if (!cancelled) setFound([]);
      }
    })();
    return () => { cancelled = true; };
  }, [sourcesVersion, authVersion]);

  return found;
}

/**
 * The source whose playlists the main screen shows: the one picked in Settings, or the
 * first that has playlists when none is picked or the picked one isn't available.
 */
export function pickPlaylistSource(found: PlaylistSource[] | null, preferred: string | null): PlaylistSource | null {
  if (!found || preferred === "off") return null;
  return found.find((entry) => entry.source.id === preferred) ?? found[0] ?? null;
}
