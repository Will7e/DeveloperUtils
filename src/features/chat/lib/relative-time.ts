// ============================================================
// Relative Time — One Short Age for the Whole Chat Surface
// ============================================================
// The sidebar's rows and the repo picker's list both answer "how stale is
// this?", and they must answer it the same way. Two implementations is how a
// repo reads as "3h" in one place and "3 hours ago" in another, and it is how
// they drift when one of them is updated.
//
// Deliberately terse: these sit in a 10–11px gutter next to a name, where
// width is the scarce resource. `now`, `12m`, `5h`, `3d`, then a real date —
// past a week, "23d" tells you less than "Feb 3" does.
// ============================================================

/** A short age: `now`, `45m`, `5h`, `3d`, `Feb 3` */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diff = Math.max(0, now - timestamp);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The same age spelled out, for a tooltip it has room for */
export function describeRelativeTime(timestamp: number, now = Date.now()): string {
  const short = formatRelativeTime(timestamp, now);
  if (!short) return "";
  if (short === "now") return "just now";
  const unit = short.slice(-1);
  const count = Number(short.slice(0, -1));
  const noun = unit === "m" ? "minute" : unit === "h" ? "hour" : unit === "d" ? "day" : null;
  if (!noun) return `last updated ${short}`;
  return `last updated ${count} ${noun}${count === 1 ? "" : "s"} ago`;
}
