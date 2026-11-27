import type { MouseEvent, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface CollapsibleHeadingProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The key that toggles the card, e.g. "Q". Cards without a key leave it out. */
  shortcut?: string;
  /** What the tooltip shows or hides, e.g. "the queue". */
  what: string;
  /** The buttons and counts on the right of the title. */
  children?: ReactNode;
  /** A section inside a card (Music's folders): a row of its own instead of the card's title. */
  row?: boolean;
}

// A card title that collapses its card (the queue, the playlists, the Settings sections). A click
// anywhere on the row toggles it; the row's own buttons still do only their own thing.
// The chevron button stays the keyboard and screen-reader way in.
export function CollapsibleHeading({ title, collapsed, onToggle, shortcut, what, children, row = false }: CollapsibleHeadingProps) {
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button, a, input, select, label")) return;
    onToggle();
  };
  const Heading = row ? "h3" : "h2";
  return (
    <div className={`section-heading toggles${row ? " row" : ""}${collapsed ? " collapsed" : ""}`} onClick={onRowClick}>
      <Heading>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed}
          aria-keyshortcuts={shortcut}
          title={`${collapsed ? "Show" : "Hide"} ${what}${shortcut ? ` (${shortcut})` : ""}`}
          onClick={onToggle}
        >
          <ChevronDown size={16} className="section-toggle-icon" aria-hidden="true" />
          {title}
        </button>
      </Heading>
      <div className="heading-actions">{children}</div>
    </div>
  );
}

interface CollapsibleCardProps {
  title: string;
  /** What the toggle's tooltip shows or hides; the title, in lower case, by default. */
  what?: string;
  /** The region's name; the title by default. */
  label?: string;
  /** Buttons for the title row (a refresh), before the count. */
  actions?: ReactNode;
  /** Beside the count: whose section it is, e.g. the MiSonos logo on its playlists. */
  badge?: ReactNode;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

// A section that's a card of its own with a collapsing title: Library's sections, and Music's
// folders and the sections of its lists, so they look and fold the same on both screens.
export function CollapsibleCard({ title, what, label, actions, badge, count, collapsed, onToggle, children }: CollapsibleCardProps) {
  return (
    <section className="queue-panel collapsible-card" aria-label={label ?? title}>
      <CollapsibleHeading title={title} collapsed={collapsed} onToggle={onToggle} what={what ?? title.toLowerCase()}>
        {actions}
        {badge}
        {typeof count === "number" ? <span>{count}</span> : null}
      </CollapsibleHeading>
      {collapsed ? null : children}
    </section>
  );
}
