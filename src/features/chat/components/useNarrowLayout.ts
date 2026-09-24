// ============================================================
// Narrow Layout — Is There Room For Two Panes?
// ============================================================
// A split view is a promise that both halves are readable. At 700px the chat
// column gets ~55% of the width beside a diff pane, which breaks that promise for
// both: prose wraps every few words and a diff has nowhere to put its line
// numbers. CSS cannot answer it either, because the split is a
// react-resizable-panels group rather than two divs a stylesheet can restack.
//
// So the answer is a breakpoint the page can branch on, at the same width the
// conversation drawer already uses (`max-width: 860px` in chat.css) — two
// breakpoints for one window would produce a layout that is half drawer, half
// split.

import React from "react";

/** The width below which the changes pane becomes a sheet */
export const NARROW_LAYOUT_QUERY = "(max-width: 860px)";

export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = React.useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(NARROW_LAYOUT_QUERY).matches
  );

  React.useEffect(() => {
    const mql = window.matchMedia(NARROW_LAYOUT_QUERY);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
