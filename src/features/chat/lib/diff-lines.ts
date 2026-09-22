// ============================================================
// Diff Lines — Classifying a Unified Diff for Rendering
// ============================================================
// A unified diff is just text, and colouring it is a prefix test —
// but the same prefix test was living inside two components, and a
// diff that renders in the Changes pane has to render identically
// when a transcript step opens into its own patch. Hence one module.

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "gap" | "context";

/**
 * Classifies one line of a unified diff.
 *
 * Order matters: file headers are `---`/`+++`, which also start with
 * `-`/`+`, so they are tested before additions and deletions. A
 * removal whose content is itself `--` (a SQL comment, Markdown rule)
 * arrives as `---…` and would otherwise be mistaken for a header,
 * which is why `---`/`+++` are only headers when they carry a
 * `/dev/null` or `a/`/`b/` marker.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (isFileHeader(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("…")) return "gap";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function isFileHeader(line: string): boolean {
  if (!line.startsWith("---") && !line.startsWith("+++")) return false;
  return (
    line.includes("/dev/null") ||
    line.startsWith("--- a/") ||
    line.startsWith("+++ b/") ||
    line.startsWith("--- a\\") ||
    line.startsWith("+++ b\\")
  );
}

/** The CSS classes one diff line renders with */
export function diffLineClass(line: string): string {
  return `chat-diff-line chat-diff-line-${classifyDiffLine(line)}`;
}
