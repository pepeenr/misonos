import { Fragment, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { SHORTCUT_GROUPS } from "./shortcuts.js";

// The shortcut list, opened with "?" or from Settings → Preferences.
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="eq-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="eq-modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "?") { event.preventDefault(); onClose(); }
        }}
      >
        <div className="shortcut-help-heading">
          <h2 className="eq-modal-title">Keyboard shortcuts</h2>
          <button type="button" className="icon-button compact" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="shortcut-help-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <div className="shortcut-row" key={entry.label}>
                    <dt>
                      {entry.keys.map((key, index) => (
                        <Fragment key={key}>
                          {index > 0 ? <span className="shortcut-or">or</span> : null}
                          <kbd>{key}</kbd>
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{entry.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
