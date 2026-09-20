import React from "react";

export type CursorType = "pointer" | "pencil" | "grab" | "grabbing";

interface VirtualCursorProps {
  x: number; // percentage (0 - 100) or pixel
  y: number; // percentage (0 - 100) or pixel
  isPercent?: boolean;
  isClicking: boolean;
  visible: boolean;
  label?: string;
  actionText?: string;
  color?: string;
  cursorType?: CursorType;
  transitionDuration?: number; // in ms
}

export function VirtualCursor({
  x,
  y,
  isPercent = true,
  isClicking,
  visible,
  label,
  actionText,
  color = "var(--accent, #0070f3)",
  cursorType = "pointer",
  transitionDuration = 550,
}: VirtualCursorProps) {
  const leftStyle = isPercent ? `${x}%` : `${x}px`;
  const topStyle = isPercent ? `${y}%` : `${y}px`;

  return (
    <div
      className={`dash-virtual-cursor ${visible ? "visible" : "hidden"} ${isClicking ? "clicking" : ""}`}
      style={
        {
          left: leftStyle,
          top: topStyle,
          "--cursor-accent": color,
          transitionDuration: `${transitionDuration}ms`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {/* Expanding Click Ripple Ring */}
      {isClicking && (
        <div
          className="dash-cursor-ripple"
          style={{
            borderColor: color,
            boxShadow: `0 0 8px ${color}60`,
          }}
        />
      )}

      {/* Vector Cursor Graphic based on cursorType */}
      {cursorType === "pencil" ? (
        <svg
          className="dash-cursor-arrow dash-cursor-pencil"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"
            fill={color}
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      ) : cursorType === "grab" || cursorType === "grabbing" ? (
        <svg
          className={`dash-cursor-arrow ${cursorType === "grabbing" ? "dash-cursor-grabbing" : ""}`}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M7 11V6a2 2 0 0 1 4 0v5M11 11V4a2 2 0 0 1 4 0v7M15 11V6a2 2 0 0 1 4 0v7a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V9a2 2 0 0 1 4 0v2"
            fill={color}
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          className="dash-cursor-arrow"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 3L10.07 20.97L13.58 13.58L20.97 10.07L3 3Z"
            fill={color}
            stroke="#ffffff"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      )}

      {/* Clean, Non-AI Action Tag */}
      {(actionText || label) && (
        <span className="dash-cursor-badge">
          {actionText || label}
        </span>
      )}
    </div>
  );
}

