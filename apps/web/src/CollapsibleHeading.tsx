import type { MouseEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface CollapsibleHeadingProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The key that toggles the card, e.g. "Q". */
  shortcut: string;
  /** What the tooltip shows or hides, e.g. "the queue". */
  what: string;
  /** The buttons and counts on the right of the title. */
  children: ReactNode;
}

// A main-screen card title that collapses its card (the queue, the playlists). A click
// anywhere on the row toggles it; the row's own buttons still do only their own thing.
// The chevron button stays the keyboard and screen-reader way in.
export function CollapsibleHeading({ title, collapsed, onToggle, shortcut, what, children }: CollapsibleHeadingProps) {
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button, a, input, select, label")) return;
    onToggle();
  };
  return (
    <div className={collapsed ? "section-heading toggles collapsed" : "section-heading toggles"} onClick={onRowClick}>
      <h2>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed}
          aria-keyshortcuts={shortcut}
          title={`${collapsed ? "Show" : "Hide"} ${what} (${shortcut})`}
          onClick={onToggle}
        >
          <ChevronDown size={16} className="section-toggle-icon" aria-hidden="true" />
          {title}
        </button>
      </h2>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
