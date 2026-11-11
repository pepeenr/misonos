import type { CSSProperties, ReactNode } from "react";
import { Disc3, Library, Pause, Play, SkipForward } from "lucide-react";
import { IconMusic } from "@tabler/icons-react";
import { artSrc } from "./api.js";
import type { View } from "./viewHistory.js";

const TABS: { view: View; label: string; keys?: string; title: string; icon: ReactNode }[] = [
  { view: "main", label: "Playing", title: "Playing (Esc)", icon: <Disc3 size={18} aria-hidden="true" /> },
  { view: "browse", label: "Music", keys: "B", title: "Music: browse sources (B)", icon: <IconMusic size={18} aria-hidden="true" /> },
  { view: "library", label: "Library", keys: "L", title: "Library: favorites and playlists (L)", icon: <Library size={18} aria-hidden="true" /> }
];

/** Playing, Music and Library as peers. A segmented control in the header on wide screens; a bar along the bottom on phones. */
export function ViewTabs({ view, onSelect }: { view: View; onSelect: (view: View) => void }) {
  return (
    <nav className="view-tabs" aria-label="Screens">
      {TABS.map((tab) => (
        <button
          key={tab.view}
          type="button"
          className="view-tab"
          aria-current={view === tab.view ? "page" : undefined}
          aria-keyshortcuts={tab.keys}
          title={tab.title}
          onClick={() => onSelect(tab.view)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

interface MiniPlayerProps {
  title: string;
  subtitle?: string;
  albumArtUri?: string;
  roomName?: string;
  /** The room's group color; edges the bar so it's clear which room the buttons drive. */
  roomColor?: string;
  playing: boolean;
  enabled: boolean;
  /** Live radio: no next track and no progress. */
  live: boolean;
  percent: number;
  onOpen: () => void;
  onPlayPause: () => void;
  onNext: () => void;
}

/** What the selected room is playing, kept in reach on Music and Library. Tapping it opens Playing. */
export function MiniPlayer({ title, subtitle, albumArtUri, roomName, roomColor, playing, enabled, live, percent, onOpen, onPlayPause, onNext }: MiniPlayerProps) {
  const style = roomColor ? ({ "--room-color": roomColor } as CSSProperties) : undefined;
  return (
    <div className="mini-player" role="region" aria-label="Now playing" style={style}>
      {!live ? (
        <div className="mini-player-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
        </div>
      ) : null}
      <button
        type="button"
        className="mini-player-open"
        title="Open Playing"
        aria-label={`Open Playing: ${title}${roomName ? ` in ${roomName}` : ""}`}
        onClick={onOpen}
      >
        <span className="mini-player-art">
          {albumArtUri ? <img src={artSrc(albumArtUri)} alt="" /> : <img src="/pwa-192x192.png" alt="" draggable={false} />}
        </span>
        <span className="mini-player-copy">
          <strong>{title}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
      </button>
      <button
        type="button"
        className="icon-button mini-player-toggle"
        title={playing ? "Pause (K)" : "Play (K)"}
        aria-label={playing ? "Pause" : "Play"}
        aria-keyshortcuts="K Space"
        disabled={!enabled}
        onClick={onPlayPause}
      >
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </button>
      {!live ? (
        <button
          type="button"
          className="icon-button mini-player-next"
          title="Next (N)"
          aria-label="Next"
          aria-keyshortcuts="N"
          disabled={!enabled}
          onClick={onNext}
        >
          <SkipForward size={18} />
        </button>
      ) : null}
    </div>
  );
}
