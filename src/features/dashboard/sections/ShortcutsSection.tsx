// ============================================================
// Keyboard shortcuts — one compact row, not a reference table
// ============================================================

import { SHORTCUTS } from "../tools";

export function ShortcutsSection() {
  return (
    <section className="dash-shortcuts" aria-labelledby="dash-shortcuts-title">
      <h2 className="dash-section-title" id="dash-shortcuts-title">
        Built for the keyboard
      </h2>

      <ul className="dash-shortcuts-row">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.label} className="dash-shortcuts-item">
            <span className="dash-shortcuts-keys">
              {shortcut.keys.map((key, index) => (
                <kbd key={`${shortcut.label}-${index}`} className="dash-kbd">
                  {key}
                </kbd>
              ))}
            </span>
            <span className="dash-shortcuts-label">{shortcut.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
