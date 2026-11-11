import { useCallback, useEffect, useRef, useState } from "react";
import { ListEnd, Play, Radio, Trash2, X } from "lucide-react";
import type { NowPlaying, PlaybackMode, PlayHistoryChange, PlayHistoryEntry } from "@misonos/sonos-protocol";
import { artSrc, bridgeApi } from "./api.js";
import { CollapsibleHeading } from "./CollapsibleHeading.js";
import { useDialogs } from "./dialogs.js";
import { applyChange, byDay } from "./history.js";

interface HistoryPanelProps {
  /** The Sonos group to play on; unset when no room is picked. */
  groupId?: string;
  /** "This device" is the target; history songs play only on the speakers. */
  localMode: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPlayed: (nowPlaying: NowPlaying) => void;
  /** The latest song the bridge wrote, from the event stream. */
  change: PlayHistoryChange | null;
}

// Rows shown at first, and added by each "Show more".
const PAGE = 30;

function timeLabel(playedAt: Date): string {
  return playedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Thumb({ src, live }: { src?: string | null; live?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="browse-thumb browse-thumb-empty" aria-hidden="true">
        {live ? <Radio size={18} /> : "♪"}
      </span>
    );
  }
  return <img className="browse-thumb" src={artSrc(src)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

// The main screen's list of the songs every room played, newest first, from any app.
// Songs from a MiSonos source can be played again from here.
export function HistoryPanel({ groupId, localMode, collapsed, onToggleCollapsed, onPlayed, change }: HistoryPanelProps) {
  const dialogs = useDialogs();
  const [entries, setEntries] = useState<PlayHistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Load the newest page when the card opens, and again when the app comes back to the
  // screen: a phone drops the event stream while the app is in the background.
  useEffect(() => {
    if (collapsed) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    void bridgeApi.playHistory(PAGE)
      .then((result) => {
        if (cancelled) return;
        const rows = Array.isArray(result) ? result : [];
        setEntries(rows);
        setHasMore(rows.length === PAGE);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the history"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [collapsed, reloadNonce]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") setReloadNonce((nonce) => nonce + 1); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const seenChangeRef = useRef<PlayHistoryChange | null>(change);
  useEffect(() => {
    if (!change || change === seenChangeRef.current) return;
    seenChangeRef.current = change;
    setEntries((current) => (current ? applyChange(current, change) : current));
  }, [change]);

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 3500 : 6000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const showMore = async () => {
    const oldest = entries?.at(-1);
    if (!oldest) return;
    setLoading(true);
    try {
      const result = await bridgeApi.playHistory(PAGE, oldest.id);
      const rows = Array.isArray(result) ? result : [];
      setEntries((current) => [...(current ?? []), ...rows.filter((row) => !current?.some((entry) => entry.id === row.id))]);
      setHasMore(rows.length === PAGE);
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't load more" });
    } finally {
      setLoading(false);
    }
  };

  const play = useCallback(async (entry: PlayHistoryEntry, mode: PlaybackMode) => {
    if (!entry.sourceId || !entry.trackId) return;
    if (!groupId || localMode) { setStatus({ ok: false, message: "Pick a room first." }); return; }
    setBusyId(entry.id);
    setStatus(null);
    try {
      const nowPlaying = await bridgeApi.playSourceItems(entry.sourceId, { trackIds: [entry.trackId], groupId, mode });
      onPlayed(nowPlaying);
      setStatus({ ok: true, message: mode === "replace" ? `Playing “${entry.title}”.` : `Added “${entry.title}” to the queue.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't play it" });
    } finally {
      setBusyId(null);
    }
  }, [groupId, localMode, onPlayed]);

  const remove = async (entry: PlayHistoryEntry) => {
    setEntries((current) => current?.filter((row) => row.id !== entry.id) ?? current);
    try {
      await bridgeApi.deletePlayHistory(entry.id);
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't remove it" });
      setReloadNonce((nonce) => nonce + 1);
    }
  };

  const clear = async () => {
    if (!(await dialogs.confirm({ message: "Clear the history of every room?", confirmLabel: "Clear" }))) return;
    try {
      await bridgeApi.clearPlayHistory();
      setEntries([]);
      setHasMore(false);
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Couldn't clear the history" });
    }
  };

  const playDisabledTitle = localMode ? "History songs play on the speakers: pick a room" : !groupId ? "Pick a room first" : undefined;

  return (
    <section className="queue-panel history-panel" aria-label="History">
      <CollapsibleHeading title="History" collapsed={collapsed} onToggle={onToggleCollapsed} shortcut="H" what="the history">
        {!collapsed ? (
          <button
            className="icon-button compact"
            type="button"
            title="Clear the history"
            aria-label="Clear the history"
            disabled={!entries?.length}
            onClick={() => void clear()}
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </CollapsibleHeading>
      {collapsed ? null : (
        <div className="history-body">
          {error ? (
            <div className="empty-panel error-panel">
              <span>{error}</span>
              <button type="button" onClick={() => setReloadNonce((nonce) => nonce + 1)}>Retry</button>
            </div>
          ) : !entries ? (
            <div className="empty-panel">Loading the history…</div>
          ) : entries.length === 0 ? (
            <div className="empty-panel">Nothing played yet. Songs show up here as they start, in every room and from any app.</div>
          ) : (
            <div className="history-scroll">
              {byDay(entries).map((day) => (
                <section key={day.label} className="history-day" aria-label={day.label}>
                  <h3 className="history-day-label">{day.label}</h3>
                  <ol className="queue-list history-list">
                    {day.entries.map((entry) => {
                      const playedAt = new Date(entry.playedAt);
                      const playable = !!entry.sourceId && !!entry.trackId;
                      const subtitle = [entry.artist, entry.album].filter(Boolean).join(" - ") || (entry.isLive ? "Radio" : "");
                      return (
                        <li key={entry.id} className="queue-item history-item">
                          <div className="history-item-main">
                            <Thumb src={entry.albumArtUri} live={entry.isLive} />
                            <span className="queue-meta">
                              <span>{entry.title}</span>
                              {subtitle ? <small>{subtitle}</small> : null}
                            </span>
                            <span className="history-when">
                              <time dateTime={entry.playedAt}>{timeLabel(playedAt)}</time>
                              <small title={entry.rooms}>{entry.rooms}</small>
                            </span>
                          </div>
                          {playable ? (
                            <>
                              <button
                                type="button"
                                className="queue-action"
                                title={playDisabledTitle ?? "Play now"}
                                aria-label={`Play ${entry.title} now`}
                                disabled={busyId !== null || !groupId || localMode}
                                aria-busy={busyId === entry.id || undefined}
                                onClick={() => void play(entry, "replace")}
                              >
                                <Play size={15} />
                              </button>
                              <button
                                type="button"
                                className="queue-action"
                                title={playDisabledTitle ?? "Add to the end of the queue"}
                                aria-label={`Add ${entry.title} to the queue`}
                                disabled={busyId !== null || !groupId || localMode}
                                onClick={() => void play(entry, "end")}
                              >
                                <ListEnd size={15} />
                              </button>
                            </>
                          ) : (
                            // Keeps the times in one column with the rows that have play buttons.
                            <span className="history-action-spacer" aria-hidden="true" />
                          )}
                          <button type="button" className="queue-remove" title="Remove from the history" aria-label={`Remove ${entry.title} from the history`} onClick={() => void remove(entry)}>
                            <X size={16} />
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
              {hasMore ? (
                <button type="button" className="playlists-more" disabled={loading} onClick={() => void showMore()}>
                  {loading ? "Loading…" : "Show more"}
                </button>
              ) : null}
            </div>
          )}
          {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}
        </div>
      )}
    </section>
  );
}
