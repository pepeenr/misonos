import { useCallback, useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { NowPlaying, SourceBrowseItem } from "@misonos/sonos-protocol";
import { artSrc, bridgeApi } from "./api.js";
import { useLocalPlayer } from "./localPlayer.js";
import type { PlaylistSource } from "./playlists.js";
import { ServiceIcon } from "./SourcePicker.js";

interface PlaylistsPanelProps {
  entry: PlaylistSource;
  /** The Sonos group to play on; unset when no room is picked. */
  groupId?: string;
  /** "This device" is the target, so playlists play in the browser. */
  localMode: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPlayed: (nowPlaying: NowPlaying) => void;
  customIcons: Record<string, string>;
}

// Tiles shown before "Show all": about two rows on a wide screen.
const PREVIEW_COUNT = 12;
// Playlists rarely change, and the main screen remounts this card on every return to
// it, so a list is reused for a while instead of fetched each time.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { items: SourceBrowseItem[]; at: number }>();

async function playableTracks(sourceId: string, item: SourceBrowseItem): Promise<SourceBrowseItem[]> {
  const expansion = await bridgeApi.browseSource(sourceId, item.id);
  return expansion.items.filter((entry) => entry.kind === "playable");
}

function PlaylistArt({ src, title }: { src?: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="preset-tile-fallback" aria-hidden="true">{title.slice(0, 2)}</span>;
  return <img src={artSrc(src)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

// The main screen's grid of the chosen source's playlists. A tile replaces the queue
// with the playlist and plays it.
export function PlaylistsPanel({ entry, groupId, localMode, collapsed, onToggleCollapsed, onPlayed, customIcons }: PlaylistsPanelProps) {
  const { source, folderId } = entry;
  const cacheKey = `${source.id}:${folderId}`;
  const localPlayer = useLocalPlayer();
  const [playlists, setPlaylists] = useState<SourceBrowseItem[] | null>(() => cache.get(cacheKey)?.items ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // Spotify plays through Sonos's own Spotify link, so there's no stream for "This device".
  const sonosOnly = source.capabilities?.includes("sonos-only") ?? false;

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 3500 : 6000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    const cached = cache.get(cacheKey);
    if (cached && refreshNonce === 0 && Date.now() - cached.at < CACHE_TTL_MS) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    void bridgeApi.browseSource(source.id, folderId)
      .then((result) => {
        if (cancelled) return;
        const items = result.items.filter((item) => item.kind === "album" || item.kind === "container");
        cache.set(cacheKey, { items, at: Date.now() });
        setPlaylists(items);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the playlists"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cacheKey, source.id, folderId, refreshNonce]);

  const play = useCallback(async (item: SourceBrowseItem) => {
    setBusyId(item.id);
    setStatus(null);
    try {
      if (localMode) {
        if (sonosOnly) { setStatus({ ok: false, message: `${source.name} plays only on Sonos speakers.` }); return; }
        const tracks = await playableTracks(source.id, item);
        if (tracks.length === 0) { setStatus({ ok: false, message: `“${item.title}” has no playable tracks.` }); return; }
        localPlayer.enqueue(tracks.map((track) => ({
          sourceId: source.id, trackId: track.id, title: track.title, artist: track.artist, album: track.album, albumArtUri: track.albumArtUri
        })), "replace");
        setStatus({ ok: true, message: `Playing “${item.title}” on this device.` });
        return;
      }
      if (!groupId) { setStatus({ ok: false, message: "Pick a room first." }); return; }
      // Queued whole in one call when the source allows it (Sonos expands a Spotify
      // playlist itself); otherwise as its tracks.
      const trackIds = item.playId ? [item.playId] : (await playableTracks(source.id, item)).map((track) => track.id);
      if (trackIds.length === 0) { setStatus({ ok: false, message: `“${item.title}” has no playable tracks.` }); return; }
      onPlayed(await bridgeApi.playSourceItems(source.id, { trackIds, groupId, mode: "replace" }));
      setStatus({ ok: true, message: `Playing “${item.title}”.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't play the playlist" });
    } finally {
      setBusyId(null);
    }
  }, [groupId, localMode, localPlayer, onPlayed, source.id, source.name, sonosOnly]);

  const shown = playlists ? (showAll ? playlists : playlists.slice(0, PREVIEW_COUNT)) : [];

  return (
    <section className="queue-panel playlists-panel" aria-label="Playlists">
      <div className={collapsed ? "section-heading collapsed" : "section-heading"}>
        <h2>
          <button
            type="button"
            className="section-toggle"
            aria-expanded={!collapsed}
            aria-keyshortcuts="Shift+L"
            title={collapsed ? "Show playlists (Shift+L)" : "Hide playlists (Shift+L)"}
            onClick={onToggleCollapsed}
          >
            <ChevronDown size={16} className="section-toggle-icon" aria-hidden="true" />
            Playlists
          </button>
        </h2>
        <div className="heading-actions">
          <span className="playlists-source">
            <ServiceIcon sourceId={source.id} customVersion={customIcons[source.id]} />
            {source.name}
          </span>
          {!collapsed ? (
            <button
              className="icon-button compact"
              type="button"
              title="Refresh playlists"
              aria-label="Refresh playlists"
              disabled={loading}
              onClick={() => setRefreshNonce((nonce) => nonce + 1)}
            >
              <RefreshCw size={16} className={loading ? "spin" : undefined} />
            </button>
          ) : null}
          <span>{playlists?.length ?? ""}</span>
        </div>
      </div>
      {collapsed ? null : (
        <div className="playlists-body">
          {error ? (
            <div className="empty-panel error-panel">
              <span>{error}</span>
              <button type="button" onClick={() => setRefreshNonce((nonce) => nonce + 1)}>Retry</button>
            </div>
          ) : !playlists ? (
            <div className="empty-panel">Loading playlists…</div>
          ) : playlists.length === 0 ? (
            <div className="empty-panel">No playlists in {source.name}.</div>
          ) : (
            <>
              <div className={showAll ? "presets-grid playlists-grid all" : "presets-grid playlists-grid"}>
                {shown.map((item, index) => {
                  const key = index < 9 ? String(index + 1) : undefined;
                  return (
                    <button
                      key={`${item.id}-${index}`}
                      type="button"
                      className={busyId === item.id ? "preset-tile playlist-tile busy" : "preset-tile playlist-tile"}
                      title={`Play ${item.title}${item.subtitle ? `\n${item.subtitle}` : ""}${key ? ` (${key})` : ""}`}
                      aria-label={`Play ${item.title}`}
                      aria-keyshortcuts={key}
                      aria-busy={busyId === item.id || undefined}
                      disabled={busyId !== null}
                      onClick={() => void play(item)}
                    >
                      <PlaylistArt src={item.albumArtUri} title={item.title} />
                      <span className="preset-tile-label">{item.title}</span>
                    </button>
                  );
                })}
              </div>
              {playlists.length > PREVIEW_COUNT ? (
                <button type="button" className="playlists-more" onClick={() => setShowAll((current) => !current)}>
                  {showAll ? "Show fewer" : `Show all ${playlists.length}`}
                </button>
              ) : null}
            </>
          )}
          {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}
        </div>
      )}
    </section>
  );
}
