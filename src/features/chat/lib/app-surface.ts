// ============================================================
// App Surface — Every Feature, Declared Once
// ============================================================
// The agent could compute on data it was given and could not read or manage
// the app's own data at all: its only reach into a feature was `open_in_tool`,
// which is write-only and hands the user a payload. So it could not answer
// "why did this request 401 last week", could not tidy a comparator session,
// could not fix a staging variable — a human can, and the difference was not
// intelligence, it was HANDS.
//
// This is the table of hands. One entry per feature family, each carrying the
// two things a family needs to be usable: a READ (what it holds, in the words
// of the user's own tool) and a list of ACTIONS (what a person does to it).
//
// Three decisions shape it, and each one exists because of a way this goes
// wrong:
//
//   • TWO TOOLS, NOT FORTY. The wire carries `read_app({family})` and
//     `act_app({family, action, args})`; the per-family detail (arg shapes,
//     what changes, what undoes) is loaded on demand through
//     `describe_tools` — the same trick the skills index already proves. A
//     hundred schemas in every request is how a model stops reading them.
//
//   • REVERSIBLE ONLY. Nothing that REMOVES a user's work is declared without
//     a reversal. `close_all_files` and `clear_history` are real user actions
//     and are absent on purpose: an agent that acts by default must act only
//     where undoing is possible, so the policy is structural rather than a
//     matter of the model's judgement. `destructive: true` marks the entries
//     that discard work; every one of them is undoable, and a test asserts
//     that invariant. The single entry with no reversal (`run_file`) only
//     appends to a console the user can clear, and changes nothing stored.
//
//   • SENSITIVITY PER FIELD, NOT PER TOOL. A read is not "sensitive" — the
//     VALUES in it are. The executors mask secret-classified values at the
//     source (see lib/sensitivity.ts) and the model is told the key, whether
//     it is present and how long it is. The API Tester already substitutes
//     `{{variable}}`, so the agent can USE a token it never sees.
//
// Pure data and pure text. The store calls live in
// services/app-surface-actions.ts, keyed by these names — a test asserts the
// two agree, so a declared action with no executor cannot ship.

import type { SensitivityClass } from "./sensitivity";

/** The feature families the agent can read and act on */
export type AppFamilyId =
  | "editor"
  | "formatters"
  | "comparators"
  | "diff"
  | "api-tester"
  | "library"
  | "drawflows"
  | "settings"
  | "activity";

export interface AppSurfaceAction {
  /** Stable action name, as `act_app` receives it */
  name: string;
  /** What it changes, in one line — the catalog line the model reads */
  summary: string;
  /** Argument shape in prose, e.g. `{ id, content, mode? }` */
  args: string;
  /** True when the action changes stored state (all but `run_file`) */
  writes: boolean;
  /** True when it removes something the user had */
  destructive?: boolean;
  /** True when the executor records a reversal for it */
  undoable?: boolean;
}

export interface AppSurfaceFamily {
  id: AppFamilyId;
  /** Human label, as the app itself names the feature */
  label: string;
  /** Data class of what a read of this family holds */
  sensitivity: SensitivityClass;
  /** When to reach for a read of this family, and what it is NOT for */
  when: string;
  /** What a read returns, in the terms the user uses */
  reads: string;
  actions: readonly AppSurfaceAction[];
}

/**
 * The families, in the order the app's sidebar lists them.
 *
 * Order is documentation: a model reading the catalog sees the editing
 * surface first, the reference material last, which matches how a person
 * moves through this app.
 */
export const APP_SURFACE: readonly AppSurfaceFamily[] = [
  {
    id: "editor",
    label: "Code Editor (the app's own tabs)",
    sensitivity: "project",
    when: "the user's snippets in this app's editor — the Code tab, not a repository. Read it before editing a tab: the content here IS the file, and guessing it overwrites the user's work",
    reads: "every open tab (id, name, language, dirty flag, full content), which one is active, and each tab's console output plus its recent run history",
    actions: [
      {
        name: "create_file",
        summary: "open a new tab with content",
        args: "{ name, language, content? }",
        writes: true,
        undoable: true,
      },
      {
        name: "update_content",
        summary: "replace or append a tab's text",
        args: '{ id, content, mode: "replace" | "append" }',
        writes: true,
        undoable: true,
      },
      { name: "rename_file", summary: "rename a tab", args: "{ id, name }", writes: true, undoable: true },
      { name: "duplicate_file", summary: "copy a tab", args: "{ id }", writes: true, undoable: true },
      {
        name: "delete_file",
        summary: "close and discard a tab",
        args: "{ id }",
        writes: true,
        destructive: true,
        undoable: true,
      },
      { name: "set_active_file", summary: "focus a tab", args: "{ id }", writes: true, undoable: true },
      {
        name: "set_stdin",
        summary: "set the input a tab's next run reads",
        args: "{ id, stdin }",
        writes: true,
        undoable: true,
      },
      // The one entry with no reversal: a run APPENDS to a console the user can
      // clear (`clearTabOutput`) and changes nothing they wrote. Undoing it
      // would delete output that may predate the run, which is a second change
      // rather than a reversal, so it is deliberately not in the ledger.
      {
        name: "run_file",
        summary: "execute a tab and put its output in that tab's console",
        args: "{ id }",
        writes: true,
      },
    ],
  },
  {
    id: "formatters",
    label: "Formatters (JSON and XML tabs)",
    sensitivity: "project",
    when: "the user works with JSON or XML documents in the Formatters page — the agent's own format_code computes on text it is given, while these are the documents the user keeps there",
    reads: "the JSON and XML tabs (id, name, content), which one is active in each type, and which type is showing",
    actions: [
      {
        name: "create_file",
        summary: "open a formatter tab",
        args: '{ formatType: "json" | "xml", name?, content? }',
        writes: true,
        undoable: true,
      },
      {
        name: "update_content",
        summary: "replace a formatter tab's document",
        args: "{ formatType, id, content }",
        writes: true,
        undoable: true,
      },
      {
        name: "rename_file",
        summary: "rename a formatter tab",
        args: "{ formatType, id, name }",
        writes: true,
        undoable: true,
      },
      {
        name: "duplicate_file",
        summary: "copy a formatter tab",
        args: "{ formatType, id }",
        writes: true,
        undoable: true,
      },
      {
        name: "set_active",
        summary: "focus a formatter tab, and optionally switch JSON/XML",
        args: "{ formatType, id }",
        writes: true,
        undoable: true,
      },
      {
        name: "delete_file",
        summary: "close and discard a formatter tab",
        args: "{ formatType, id }",
        writes: true,
        destructive: true,
        undoable: true,
      },
    ],
  },
  {
    id: "comparators",
    label: "Comparators (list, JSON and env comparisons)",
    sensitivity: "project",
    when: "the user keeps comparison sessions here — two sides they are comparing. The agent's own compare_data compares two inputs it is HANDED; read this family when the comparison itself is what the user is working on",
    reads: "every session (id, name, mode, both sides) and the active session, plus the comparison settings (case sensitivity, whitespace, sorting)",
    actions: [
      {
        name: "create",
        summary: "start a new comparison",
        args: '{ name?, mode: "list" | "json" | "env" }',
        writes: true,
        undoable: true,
      },
      {
        name: "update_input",
        summary: "set one side of a comparison",
        args: '{ id, side: "a" | "b", input }',
        writes: true,
        undoable: true,
      },
      { name: "swap_inputs", summary: "swap the two sides", args: "{ id }", writes: true, undoable: true },
      { name: "set_mode", summary: "change how the sides are compared", args: "{ id, mode }", writes: true, undoable: true },
      { name: "rename", summary: "rename a session", args: "{ id, name }", writes: true, undoable: true },
      { name: "duplicate", summary: "copy a session", args: "{ id }", writes: true, undoable: true },
      { name: "set_active", summary: "focus a session", args: "{ id }", writes: true, undoable: true },
      {
        name: "delete",
        summary: "discard a session",
        args: "{ id }",
        writes: true,
        destructive: true,
        undoable: true,
      },
      {
        name: "update_settings",
        summary: "change comparison settings",
        args: "{ caseSensitive?, trimWhitespace?, sortAlpha? }",
        writes: true,
        undoable: true,
      },
    ],
  },
  {
    id: "diff",
    label: "Diff Checker",
    sensitivity: "project",
    when: "the user's saved diff sessions — text they are comparing here. The agent's diff_text computes a diff of two inputs it is given without touching these",
    reads: "every session (id, name, language, original and modified text) and the active session, plus the diff settings",
    actions: [
      { name: "create", summary: "start a new diff", args: "{ name? }", writes: true, undoable: true },
      {
        name: "update_input",
        summary: "set one side of a diff",
        args: '{ id, side: "original" | "modified", input }',
        writes: true,
        undoable: true,
      },
      {
        name: "set_language",
        summary: "set a session's language",
        args: "{ id, language, autoDetect? }",
        writes: true,
        undoable: true,
      },
      { name: "rename", summary: "rename a session", args: "{ id, name }", writes: true, undoable: true },
      { name: "duplicate", summary: "copy a session", args: "{ id }", writes: true, undoable: true },
      { name: "set_active", summary: "focus a session", args: "{ id }", writes: true, undoable: true },
      { name: "delete", summary: "discard a session", args: "{ id }", writes: true, destructive: true, undoable: true },
      {
        name: "update_settings",
        summary: "change diff settings",
        args: "{ renderSideBySide?, ignoreTrimWhitespace?, wordWrap?, autoFormatOnPaste?, enableSplitViewResizing? }",
        writes: true,
        undoable: true,
      },
    ],
  },
  {
    id: "api-tester",
    label: "API Tester",
    sensitivity: "personal",
    when: "the user's requests, their history and their environments. This is where an endpoint they mention LIVES, so read it before asking which URL, method or environment they mean — and read the history before suggesting a fix, because the failure they are describing may already be recorded with its status and body",
    reads: "the request tabs (method, url, params, headers, body, auth with secret values masked), the history (method, url, status, timing, request and response bodies), the imported collections, and the global variables and environments with secret values masked",
    actions: [
      // Closing a request tab is deliberately ABSENT: a tab holds state this
      // store has no action to recreate (response, websocket history, the
      // exact header ids), so it could not be put back. The user closes tabs.
      { name: "create_tab", summary: "open a blank request tab", args: "{}", writes: true, undoable: true },
      { name: "set_active_tab", summary: "focus a request tab", args: "{ id }", writes: true, undoable: true },
      { name: "rename_tab", summary: "rename a request tab", args: "{ id, name }", writes: true, undoable: true },
      {
        name: "set_request",
        summary: "set a tab's method, url, body or protocol",
        args: '{ tabId?, method?, url?, bodyType?, body?, protocol?, useProxy? }',
        writes: true,
        undoable: true,
      },
      {
        name: "set_header",
        summary: "add or replace a request header",
        args: "{ tabId?, key, value }",
        writes: true,
        undoable: true,
      },
      { name: "remove_header", summary: "remove a request header", args: "{ tabId?, key }", writes: true, undoable: true },
      {
        name: "set_auth",
        summary: "set how a tab authenticates (secret fields take {{variable}} references)",
        args: '{ tabId?, type: "none" | "bearer" | "basic" | "api-key", config? }',
        writes: true,
        undoable: true,
      },
      {
        name: "add_environment",
        summary: "create an environment (Staging, Production, …)",
        args: "{ name }",
        writes: true,
        undoable: true,
      },
      { name: "rename_environment", summary: "rename an environment", args: "{ id, name }", writes: true, undoable: true },
      {
        name: "set_active_environment",
        summary: "choose which environment requests use",
        args: "{ id | null }",
        writes: true,
        undoable: true,
      },
      {
        name: "set_var",
        summary: "set or clear one variable (global, or in an environment)",
        args: '{ environmentId? | null, key, value?, remove? }',
        writes: true,
        undoable: true,
      },
    ],
  },
  {
    id: "library",
    label: "Library (ServiceNow and diagram reference)",
    sensitivity: "public",
    when: "the reference material the app ships — browsing it is how the user picks something to work from. The agent's search_library already searches it; this family is the browsing STATE (what is selected, filtered, showing)",
    reads: "the selected item, the search query, which tab is showing and the active category",
    actions: [
      { name: "select_item", summary: "select an item", args: "{ id | null }", writes: true, undoable: true },
      { name: "search", summary: "set the library search box", args: "{ query, tab? }", writes: true, undoable: true },
      {
        name: "set_tab",
        summary: "switch library section",
        args: '{ tab: "servicenow" | "drawflow" | "excalidraw" }',
        writes: true,
        undoable: true,
      },
      { name: "set_category", summary: "filter to a category", args: "{ category }", writes: true, undoable: true },
    ],
  },
  {
    id: "drawflows",
    label: "DrawFlows (the diagram boards)",
    sensitivity: "project",
    when: "the boards the user has drawn. `create_diagram` draws a NEW board from a spec the model writes, while this family reads and manages the boards that already exist — the right choice when the user refers to a board they already have",
    reads: "every board (id, name, element count, updated time) and which one is active",
    actions: [
      { name: "create_board", summary: "create an empty board", args: "{ name? }", writes: true, undoable: true },
      { name: "rename_board", summary: "rename a board", args: "{ id, name }", writes: true, undoable: true },
      { name: "duplicate_board", summary: "copy a board", args: "{ id }", writes: true, undoable: true },
      { name: "set_active_board", summary: "focus a board", args: "{ id }", writes: true, undoable: true },
      {
        name: "delete_board",
        summary: "discard a board",
        args: "{ id }",
        writes: true,
        destructive: true,
        undoable: true,
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    sensitivity: "personal",
    when: "the app's own preferences — the editor's font size and tab width, execution timeout, sidebar behaviour. Read before changing them: a person's editor settings are theirs",
    reads: "the editor settings, the comparison and diff settings, and whether the sidebar and output panel are open",
    actions: [
      {
        name: "update_editor",
        summary: "change editor preferences",
        args: "{ theme?, fontSize?, tabSize?, wordWrap?, minimap?, lineNumbers?, formatOnPaste?, formatOnType?, executionTimeout?, sidebarAutoCollapse?, sidebarAutoCollapseDelay? }",
        writes: true,
        undoable: true,
      },
      {
        name: "toggle_panel",
        summary: "open or close the sidebar or the output panel",
        args: '{ panel: "sidebar" | "output", open: boolean }',
        writes: true,
        undoable: true,
      },
    ],
  },
  {
    id: "activity",
    label: "Activity (what the agent has done in this app)",
    sensitivity: "personal",
    when: "the running record of the agent's own writes to this app this session — read it to answer \"what did you change\" honestly, and to undo a change you regret",
    reads: "each recorded action (id, family, action, one-line summary, when, whether it was already undone)",
    actions: [
      {
        name: "undo",
        summary: "put one recorded change back the way it was",
        args: "{ id }",
        writes: true,
        undoable: false,
      },
    ],
  },
];

/** Lookup by id */
export function appFamily(id: string): AppSurfaceFamily | undefined {
  return APP_SURFACE.find((f) => f.id === id);
}

/** Every family id, for validation and error messages */
export const APP_FAMILY_IDS: readonly string[] = APP_SURFACE.map((f) => f.id);

/** One catalog line per family, for the `read_app` / `act_app` descriptions */
export function familyLine(family: AppSurfaceFamily): string {
  return `- \`${family.id}\` (${family.label}): ${family.reads}`;
}

/**
 * The one-line-per-family index, as the always-on tools describe it.
 *
 * This is the whole reason the wire stays small: thirty family ids cost the
 * same as three tool schemas, and the detail is one `describe_tools` call
 * away when the turn actually needs it.
 */
export function familyIndex(): string {
  return APP_SURFACE.map(familyLine).join("\n");
}

/**
 * The full detail for one family: when to use it, what it reads, and every
 * action with its argument shape.
 *
 * Rendered as text rather than JSON because it lands in a tool RESULT, which
 * the model reads as prose — and because a person reading the transcript can
 * follow it.
 */
export function familyDetail(family: AppSurfaceFamily): string {
  const lines: string[] = [
    `${family.id} — ${family.label}`,
    `Read it when: ${family.when}`,
    `A read returns: ${family.reads}`,
    `Data class: ${family.sensitivity}`,
    "Actions:",
  ];
  for (const action of family.actions) {
    const marks = [
      action.writes ? "" : "read-only",
      action.destructive ? "destructive" : "",
      action.writes && action.undoable ? "undoable" : "",
      action.writes && !action.undoable ? "NOT undoable" : "",
    ].filter(Boolean);
    lines.push(`- \`${action.name}\`${action.args} — ${action.summary}${marks.length ? ` [${marks.join(", ")}]` : ""}`);
  }
  return lines.join("\n");
}

/**
 * The whole catalog, or a named subset.
 *
 * An unknown name is reported rather than silently skipped: a model that asks
 * about `api_tester` (underscore, not hyphen) should be told the real id, not
 * handed an empty list.
 */
export function describeFamilies(
  ids?: readonly string[]
): { text: string; unknown: string[] } {
  if (!ids || ids.length === 0) {
    return { text: APP_SURFACE.map(familyDetail).join("\n\n"), unknown: [] };
  }
  const unknown: string[] = [];
  const text: string[] = [];
  for (const id of ids) {
    const family = appFamily(id);
    if (!family) {
      unknown.push(id);
      continue;
    }
    text.push(familyDetail(family));
  }
  return { text: text.join("\n\n"), unknown };
}

/** The sentence that tells the model how to use the families at all */
export const APP_SURFACE_RULE =
  "Every feature of this app is a FAMILY you can read and act on through `read_app` and `act_app`. " +
  "Read the family before you act on it, and describe a family with `describe_tools` when you need its action shapes. " +
  "A family read is a fact about the user's own work, not a guess — prefer it to asking which request, board or environment they mean.";
