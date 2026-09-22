// ============================================================
// DiffView — One Unified Diff, Rendered
// ============================================================
// The Changes pane and an expanded transcript step both show a patch,
// and they must look the same: same classes, same line colours, same
// handling of the truncation gap. Both render this component.

import React from "react";
import { diffLineClass } from "../lib/diff-lines";

export const DiffView = React.memo(function DiffView({
  patch,
  className,
  maxHeight,
}: {
  /** Unified diff text (may carry the truncation marker) */
  patch: string;
  className?: string;
  /** Optional viewport cap, e.g. "40vh" for an in-transcript diff */
  maxHeight?: string;
}) {
  const lines = React.useMemo(() => patch.split("\n"), [patch]);
  return (
    <pre
      className={className ? `chat-changes-patch ${className}` : "chat-changes-patch"}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {lines.map((line, index) => (
        <div key={index} className={diffLineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
});
