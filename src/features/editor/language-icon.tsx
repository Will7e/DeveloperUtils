// ============================================================
// Language Icon — shared language tile for sidebar / tabs / menus
// ============================================================
// Replaces the old text badges (JS / TS / PY / <>) with a single
// visual language: a rounded tile tinted in the language's brand
// color, carrying a FileCode2-style glyph. Same component everywhere
// keeps the compiler chrome (sidebar, tab bar, dropdowns) consistent
// with the Geist design system used by the chat sidebar.

import { FileCode2, Database, Braces } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Language } from "@/types";

interface LanguageVisual {
  /** Lucide glyph rendered inside the tile */
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Tile background + icon color (dark theme values) */
  className: string;
}

const LANGUAGE_VISUALS: Record<Language, LanguageVisual> = {
  javascript: { Icon: Braces, className: "lang-tile-js" },
  typescript: { Icon: Braces, className: "lang-tile-ts" },
  python: { Icon: FileCode2, className: "lang-tile-py" },
  html: { Icon: FileCode2, className: "lang-tile-html" },
  sql: { Icon: Database, className: "lang-tile-sql" },
  lua: { Icon: FileCode2, className: "lang-tile-lua" },
};

interface LanguageIconProps {
  language: Language;
  /** Tile size — sm (20px) fits list rows, md (24px) fits dropdowns */
  size?: "sm" | "md";
  className?: string;
}

export function LanguageIcon({ language, size = "sm", className }: LanguageIconProps) {
  const visual = LANGUAGE_VISUALS[language];
  if (!visual) return null;
  const { Icon } = visual;

  return (
    <span
      className={cn(
        "lang-tile",
        size === "sm" ? "lang-tile-sm" : "lang-tile-md",
        visual.className,
        className
      )}
      aria-hidden="true"
    >
      <Icon className="lang-tile-glyph" strokeWidth={2.25} />
    </span>
  );
}
