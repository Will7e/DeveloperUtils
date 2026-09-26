// ============================================================
// Dashboard copy + tool catalog — single source of truth
// ============================================================
// Every claim below is traceable to shipped code. The demo stage renders its
// switcher, its window titles and its caption from this list, so the page can
// never advertise something the app does not ship. Verify before editing:
//   - runtimes + timeout .................. config/index.ts, services/compiler.service.ts
//   - protocols, environments, cURL ....... stores/api-tester.store.ts
//   - OpenRouter BYO key + AES-256-GCM .... features/chat, services/crypto.service.ts
//   - 230+ shape packs .................... utils/drawflowLibrary.ts, features/drawflows
//   - formatters are JSON + XML only ...... features/formatters (jsonUtils, xmlUtils)
//   - Monaco diff, ignore whitespace ...... features/diff-checker/DiffChecker.tsx
//   - .env / JSON / list modes ............ features/comparators
//   - 125+ APIs, 720+ signatures .......... servicenow_api_library_scripts.json, features/library

export interface DashboardTool {
  id: string;
  to: string;
  /** Label on the demo switcher — the shortest honest name for the tool. */
  short: string;
  /** One line under the demo explaining what that tool does. */
  tagline: string;
  /** Fake file name for the demo window chrome. */
  demoTitle: string;
  /** Runtime chips for the demo window chrome. */
  demoMeta: string[];
}

/** Order matches the sidebar and the ⌥1–8 jump shortcuts. */
export const DASHBOARD_TOOLS: DashboardTool[] = [
  {
    id: "compiler",
    to: "/compiler",
    short: "Compiler",
    tagline: "Runs JavaScript, TypeScript, Python and HTML in a sandboxed worker.",
    demoTitle: "script.ts",
    demoMeta: ["Web Worker", "no upload"],
  },
  {
    id: "api-tester",
    to: "/api-tester",
    short: "API Tester",
    tagline: "Sends REST, GraphQL and WebSocket requests straight from your browser.",
    demoTitle: "request.http",
    demoMeta: ["REST · GraphQL · WS"],
  },
  {
    id: "chat",
    to: "/chat",
    short: "Agents",
    tagline: "Streams answers from hundreds of models with your own OpenRouter key.",
    demoTitle: "chat.md",
    demoMeta: ["OpenRouter", "your key"],
  },
  {
    id: "drawflows",
    to: "/drawflows",
    short: "DrawFlows",
    tagline: "Diagrams systems on an infinite canvas with 230+ community shape packs.",
    demoTitle: "architecture.canvas",
    demoMeta: ["infinite canvas"],
  },
  {
    id: "formatters",
    to: "/formatters",
    short: "Formatters",
    tagline: "Prettifies or minifies JSON and XML, with exact error positions.",
    demoTitle: "data.json",
    demoMeta: ["JSON", "XML"],
  },
  {
    id: "diff",
    to: "/diff",
    short: "Diff Check",
    tagline: "Compares two files side by side or inline, and can ignore whitespace.",
    demoTitle: "diff_comparison.ts",
    demoMeta: ["split · inline"],
  },
  {
    id: "comparators",
    to: "/comparators",
    short: "Comparators",
    tagline: "Audits .env files, JSON documents and lists without uploading secrets.",
    demoTitle: "env_audit.conf",
    demoMeta: ["secrets stay local"],
  },
  {
    id: "library",
    to: "/library",
    short: "Library",
    tagline: "Searches 125+ verified ServiceNow APIs bundled with the app.",
    demoTitle: "servicenow_reference.js",
    demoMeta: ["125+ APIs"],
  },
];

export const TOOL_COUNT = DASHBOARD_TOOLS.length;

export const HERO = {
  titleLead: "InTab — Developer Tools ",
  titleAccent: "Right in Your Browser",
  subtitle:
    "An all-in-one local-first developer suite featuring in-browser code compilers, REST & GraphQL API testing, visual system diagrams, and formatters. 100% free with no login or account required. Optional encrypted Google Drive Cloud Sync backs up your snippets and workspace across devices.",
  primaryCta: { label: "Jump to a tool", shortcut: "⌘K" },
  trust: [`${TOOL_COUNT} developer tools`, "no account or login required", "runs 100% locally", "optional Google Drive backup"],
};

export interface PrivacyPoint {
  title: string;
  body: string;
}

export const PRIVACY_POINTS: PrivacyPoint[] = [
  {
    title: "Sandboxed on your machine",
    body: "Code runs in a worker with a hard timeout; Python runs as WebAssembly.",
  },
  {
    title: "Encrypted at rest",
    body: "Keys, credentials and saved state are sealed with AES-256-GCM, per device.",
  },
  {
    title: "Our servers are not in the path",
    body: "Agents calls OpenRouter with your key; cloud sync writes to your own drive.",
  },
  {
    title: "A locked-down page",
    body: "Strict Content-Security-Policy, no third-party scripts, no analytics.",
  },
];

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Is my code or data uploaded anywhere?",
    answer:
      "No. Every tool runs in your browser and this page makes no requests of its own. The only two exceptions are features you explicitly connect: Agents sends prompts to OpenRouter using your key, and cloud sync writes an encrypted file to your own cloud drive.",
  },
  {
    question: "Do I need an account?",
    answer:
      "Never. There is no signup, no login and no email. Every tool runs directly in your browser with zero setup.",
  },
  {
    question: "Does it work offline?",
    answer:
      "The tools and the bundled ServiceNow reference keep working once the page has loaded, because nothing calls a server. The page itself still needs to load from the web — there is no service worker yet.",
  },
  {
    question: "Where do my secrets live?",
    answer:
      "In your browser's local storage, encrypted with AES-256-GCM and a key held on your device. Nothing readable is written to disk, and cloud sync encrypts everything again before it leaves.",
  },
];

export interface ShortcutHint {
  keys: string[];
  label: string;
}

export const SHORTCUTS: ShortcutHint[] = [
  { keys: ["⌘", "K"], label: "Command palette" },
  { keys: ["⌥", "1–9"], label: "Jump to a tool" },
  { keys: ["⌘", "↩"], label: "Run script" },
  { keys: ["⌘", "S"], label: "Format and save" },
  { keys: ["⌘", "B"], label: "Collapse sidebar" },
];
