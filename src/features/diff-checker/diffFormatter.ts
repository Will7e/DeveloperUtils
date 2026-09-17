// ============================================================
// Auto-Formatting Engine for Diff Checker
// Re-exports and builds on universal Formatter Service
// ============================================================

import {
  type FormatResult,
  formatContent,
  formatSql,
  isFormatSupported,
} from "@/services/formatter.service";

export type { FormatResult };
export { formatContent, formatSql, isFormatSupported };

/**
 * Format both Original and Modified sides.
 */
export async function formatBothSides(
  original: string,
  modified: string,
  language: string
): Promise<{ original: string; modified: string; changed: boolean; errors: string[] }> {
  const errors: string[] = [];
  let nextOrig = original;
  let nextMod = modified;
  let changed = false;

  if (original.trim()) {
    const resOrig = await formatContent(original, language);
    if (resOrig.success && resOrig.formatted !== original) {
      nextOrig = resOrig.formatted;
      changed = true;
    } else if (resOrig.error) {
      errors.push(`Original: ${resOrig.error}`);
    }
  }

  if (modified.trim()) {
    const resMod = await formatContent(modified, language);
    if (resMod.success && resMod.formatted !== modified) {
      nextMod = resMod.formatted;
      changed = true;
    } else if (resMod.error) {
      errors.push(`Modified: ${resMod.error}`);
    }
  }

  return { original: nextOrig, modified: nextMod, changed, errors };
}
