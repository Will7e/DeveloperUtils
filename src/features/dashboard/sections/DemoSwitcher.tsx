// ============================================================
// DemoSwitcher — the thin strip of demonstrable tools on the window
// ============================================================
// This is the page's only tool picker, and it doubles as the demo tabs, so
// it stays a strip: no cards, no icons, no second "open" link per tool. It
// implements the ARIA tabs pattern with roving focus, which means eight
// demos cost one row and one tab stop instead of eight of each.
//
// The active tab shows a slim progress fill bar that counts down before
// the carousel advances to the next demo. Hovering the demo area pauses
// the timer and the bar holds its position.

import { useRef, type KeyboardEvent } from "react";
import { DASHBOARD_TOOLS } from "../tools";

export interface DemoSwitcherProps {
  activeId: string;
  onSelect: (id: string) => void;
  /** 0 → 1 progress of the auto-rotation timer. Undefined = no auto-rotation. */
  progress?: number;
  /** True when the countdown is paused (hover / interaction). */
  isPaused?: boolean;
}

export function DemoSwitcher({ activeId, onSelect, progress, isPaused }: DemoSwitcherProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const selectAt = (index: number) => {
    const tool = DASHBOARD_TOOLS[index];
    if (!tool) return;
    onSelect(tool.id);
    // Focus follows selection: the arrow keys move through the strip.
    buttons.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = DASHBOARD_TOOLS.findIndex((tool) => tool.id === activeId);
    const last = DASHBOARD_TOOLS.length - 1;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        selectAt(current >= last ? 0 : current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        selectAt(current <= 0 ? last : current - 1);
        break;
      case "Home":
        selectAt(0);
        break;
      case "End":
        selectAt(last);
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  return (
    <div
      className="dash-demo-switcher"
      role="tablist"
      aria-label="Choose a live demo"
      onKeyDown={handleKeyDown}
    >
      {DASHBOARD_TOOLS.map((tool, index) => {
        const isActive = tool.id === activeId;
        return (
          <button
            key={tool.id}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            id={`demo-tab-${tool.id}`}
            role="tab"
            aria-selected={isActive}
            aria-controls="dash-demo-panel"
            tabIndex={isActive ? 0 : -1}
            className={`dash-demo-switcher-btn${isActive ? " is-active" : ""}`}
            onClick={() => onSelect(tool.id)}
          >
            <span className="dash-demo-switcher-label">{tool.short}</span>
            {isActive && progress !== undefined && (
              <span
                className={`dash-demo-switcher-progress${isPaused ? " is-paused" : ""}`}
                style={{ "--progress": progress } as React.CSSProperties}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

