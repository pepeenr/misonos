import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { SourceBrowseItem } from "@misonos/sonos-protocol";
import { CollapsibleHeading } from "./CollapsibleHeading.js";

interface BrowseResult {
  items: SourceBrowseItem[];
}

interface BrowseFolderProps {
  folder: SourceBrowseItem;
  open: boolean;
  onToggle: () => void;
  /** The folder's items as last loaded this session, if any. */
  cached?: BrowseResult;
  /** Loads a folder's items; fresh skips the session cache. Stable per source and login. */
  load: (id: string, fresh: boolean) => Promise<BrowseResult>;
  /** The open folder's rows (and its "Play all" bar). */
  renderItems: (items: SourceBrowseItem[]) => ReactNode;
}

// One of a source's top-level folders in Music (Playlists, Liked Songs, Albums…). It opens
// in place, with the same title row as the cards on the other screens, and loads its items
// the first time it's opened.
export function BrowseFolder({ folder, open, onToggle, cached, load, renderItems }: BrowseFolderProps) {
  const [result, setResult] = useState<BrowseResult | undefined>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchItems = useCallback((fresh: boolean) => {
    let cancelled = false;
    setLoading(true);
    setError("");
    load(folder.id, fresh)
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to browse"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, folder.id]);

  useEffect(() => {
    if (!open || result) return undefined;
    return fetchItems(false);
  }, [open, result, fetchItems]);

  const count = result?.items.filter((item) => item.kind !== "section").length;

  return (
    <li className="browse-folder">
      <CollapsibleHeading row title={folder.title} collapsed={!open} onToggle={onToggle} what={folder.title}>
        {open ? (
          <button
            className="icon-button compact"
            type="button"
            title="Refresh"
            aria-label={`Refresh ${folder.title}`}
            disabled={loading}
            onClick={() => fetchItems(true)}
          >
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
          </button>
        ) : null}
        {count !== undefined ? <span>{count}</span> : null}
      </CollapsibleHeading>
      {!open ? null : error ? (
        <div className="empty-panel error-panel">
          <span>{error}</span>
          <button type="button" onClick={() => fetchItems(true)}>Retry</button>
        </div>
      ) : !result ? (
        <div className="empty-panel">Loading…</div>
      ) : result.items.length === 0 ? (
        <div className="empty-panel">No items.</div>
      ) : renderItems(result.items)}
    </li>
  );
}
