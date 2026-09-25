// ============================================================
// Editor font presets — one list, used by Settings and the palette
// ============================================================
// The first entry is the app default (DEFAULT_EDITOR_SETTINGS.fontFamily);
// keep them in sync. Values are full CSS font-family stacks so a missing
// webfont degrades gracefully through the fallbacks.

export interface FontOption {
  label: string;
  value: string;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    label: "JetBrains Mono",
    value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  },
  {
    label: "Cascadia Code",
    value: "'Cascadia Code', 'JetBrains Mono', monospace",
  },
  {
    label: "Courier New",
    value: "'Courier New', Courier, monospace",
  },
  {
    label: "Liberation Sans",
    value: "'Liberation Sans', system-ui, sans-serif",
  },
  {
    label: "System UI",
    value: "system-ui, sans-serif",
  },
];
