import { useCallback, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { CollapsibleHeading } from "./CollapsibleHeading.js";
import { SETTINGS_COLLAPSED_PREF, readLocalPref, setLocalPref } from "./prefs.js";

/** Whether a Settings section is collapsed, remembered per device under the section's id. */
function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readLocalPref(SETTINGS_COLLAPSED_PREF)?.[id] === true);
  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
    // Read the stored record again: the other sections write to it too.
    const stored = { ...(readLocalPref(SETTINGS_COLLAPSED_PREF) ?? {}) };
    if (collapsed) delete stored[id]; else stored[id] = true;
    setLocalPref(SETTINGS_COLLAPSED_PREF, stored);
  }, [id, collapsed]);
  return [collapsed, toggle];
}

interface SettingsSectionProps {
  /** Keeps the open/closed state; it must stay the same between releases. */
  id: string;
  title: string;
  /** The section's accessible name; the title when left out. */
  label?: string;
  /** Buttons on the right of the title (refresh, add). Clicking one doesn't toggle. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A Settings section with a title that folds it away. The content stays mounted while
 * folded (just hidden), so a section keeps what it loaded and what's typed in it.
 */
export function SettingsSection({ id, title, label, actions, children }: SettingsSectionProps) {
  const [collapsed, toggle] = useCollapsed(id);
  return (
    <section className="queue-panel" aria-label={label ?? title}>
      <CollapsibleHeading title={title} collapsed={collapsed} onToggle={toggle} what={`the ${title.toLowerCase()} section`}>
        {actions}
      </CollapsibleHeading>
      <div hidden={collapsed}>{children}</div>
    </section>
  );
}

interface SettingsCardProps {
  id: string;
  title: string;
  label?: string;
  children: ReactNode;
}

/** The same fold for the smaller Settings cards (YouTube Music, Spotify, YouTube links). */
export function SettingsCard({ id, title, label, children }: SettingsCardProps) {
  const [collapsed, toggle] = useCollapsed(id);
  return (
    <section className={collapsed ? "settings-card collapsed" : "settings-card"} aria-label={label}>
      <h3>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed}
          title={`${collapsed ? "Show" : "Hide"} the ${title.toLowerCase()} section`}
          onClick={toggle}
        >
          <ChevronDown size={16} className="section-toggle-icon" aria-hidden="true" />
          {title}
        </button>
      </h3>
      <div className="settings-card-body" hidden={collapsed}>{children}</div>
    </section>
  );
}
