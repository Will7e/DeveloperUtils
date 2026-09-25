// ============================================================
// App Surface Actions — The Hands Behind read_app and act_app
// ============================================================
// Where lib/app-surface.ts DECLARES the families, this module performs them:
// one read per family and one executor per declared action, dispatching into
// the stores' OWN actions — the same functions the UI calls. That is the whole
// point of the design: a feature is agent-drivable exactly when its store
// actions are reachable through one thin bridge, so no feature needs a bespoke
// tool and no new feature needs teaching.
//
// Three rules this module keeps, each for a reason:
//
//   • READS MASK AT THE SOURCE. A secret-classified value (see lib/sensitivity)
//     never enters the returned payload — the key, its presence and its length
//     do, and nothing else. Masking here rather than in the prompt is the
//     difference between a policy and a hope: the transcript is written from
//     this return value, so a value that was never in it cannot leak later.
//
//   • WRITES ARE REVERSIBLE AND RECORDED. Every executor that changes stored
//     state returns an `undo` closure captured from the state BEFORE the call,
//     and the dispatcher records it in the action ledger. The reversal is a
//     closure, not a description, so there is exactly one implementation of
//     "put it back" instead of two that can disagree.
//
//   • A MISS IS NAMED. An unknown family lists the real ones, an unknown action
//     lists that family's actions, and an unknown id lists the ids that exist.
//     A model that asked about `api_tester` (underscore) should be corrected,
//     not stonewalled — the same self-correcting error style as the registry.
//
// Two deliberate exceptions to "dispatch through store actions". Where the
// store exposes no action that can restore what was removed (closing a tab, a
// session, a board) the reversal replaces the affected slice directly through
// `setState`; a delete with no reversal is worse than a direct write. The
// api-tester store persists through its own calls rather than middleware, so
// that path re-selects the current tab afterwards to force the same save an
// action would have made.

import { useAppStore } from "@/stores/app.store";
import {
  useApiTesterStore,
  type AuthConfig,
  type AuthType,
  type BodyType,
  type Environment,
  type HttpMethod,
  type KeyValueField,
  type TabState,
} from "@/stores/api-tester.store";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { APP_SURFACE, appFamily, describeFamilies, familyIndex } from "../lib/app-surface";
import { listAppActions, recordAppAction, undoAppAction } from "../lib/app-action-ledger";
import { isSecretHeader, isSecretKey, maskValue } from "../lib/sensitivity";

// ── Outcome shapes ───────────────────────────────────────────

export type AppReadOutcome =
  | { ok: true; data: Record<string, unknown>; summary: string }
  | { ok: false; error: string; summary: string };

export type AppActOutcome =
  | { ok: true; data: Record<string, unknown>; summary: string }
  | { ok: false; error: string; summary: string };

/**
 * What an executor returns: the payload the model reads, the activity summary,
 * and the reversal when the change can be put back.
 */
interface Effect {
  data: Record<string, unknown>;
  summary: string;
  undo?: () => void;
}

/** Thrown for a bad argument or a missing target; turned into a result, never propagated */
class AppActionError extends Error {}

// ── Caps (a read is a window, not the whole store) ────────────

const READ_TEXT_CAP = 4_000;
const SMALL_TEXT_CAP = 1_200;
const HISTORY_LIMIT = 20;
const CONSOLE_TAIL = 10;

// ── Small helpers ────────────────────────────────────────────

const appStore = () => useAppStore.getState();
const apiStore = () => useApiTesterStore.getState();

function cap(text: string, max = READ_TEXT_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[${text.length - max} more characters — open it in the app to read the rest]`;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/** A stable-looking id for a field this module creates (the store's own format) */
function fieldId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  opts: { allowEmpty?: boolean; what?: string } = {}
): string {
  const raw = args[key];
  if (typeof raw !== "string") {
    throw new AppActionError(`\`${key}\` is required and must be a string${opts.what ? ` (${opts.what})` : ""}.`);
  }
  const value = raw;
  if (!opts.allowEmpty && value.trim() === "") {
    throw new AppActionError(`\`${key}\` must not be empty.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  return typeof raw === "string" ? raw : undefined;
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = requireString(args, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new AppActionError(`\`${key}\` must be one of: ${allowed.join(", ")}. Got "${value}".`);
  }
  return value as T;
}

function requireLanguage(args: Record<string, unknown>, key: string): Language {
  const value = requireString(args, key);
  if (!(value in LANGUAGE_CONFIGS)) {
    throw new AppActionError(
      `\`${key}\` must be a language this app can run: ${Object.keys(LANGUAGE_CONFIGS).join(", ")}.`
    );
  }
  return value as Language;
}

/** The error for an id that does not exist, with the ids that do */
function noSuch(kind: string, id: string, known: readonly string[]): AppActionError {
  const list = known.length > 0 ? ` Existing ${kind} ids: ${known.join(", ")}.` : ` There are no ${kind} yet.`;
  return new AppActionError(`No ${kind} with id "${id}".${list} Read the family to see them.`);
}

/** A masked stand-in for a value that must not travel; empty stays visibly empty */
function masked(value: string): string {
  return value === "" ? "" : maskValue(value).display;
}

function outputTail(fileId: string) {
  const exec = appStore().tabExec[fileId];
  return {
    stdin: exec?.stdin ?? "",
    isRunning: exec?.isRunning ?? false,
    console: (exec?.outputEntries ?? []).slice(-CONSOLE_TAIL).map((e) => ({
      type: e.type,
      content: cap(e.content, 800),
    })),
    recentRuns: (exec?.runHistory ?? []).slice(0, 5).map((r) => ({
      id: r.id,
      at: iso(r.ranAt),
      exitCode: r.result.exitCode,
      stdout: cap(r.result.stdout, 600),
      stderr: cap(r.result.stderr, 400),
    })),
  };
}

// ── Reads: one per family, secrets masked at the source ──────

function readEditor(): Record<string, unknown> {
  const s = appStore();
  return {
    activeFileId: s.activeFileId,
    files: s.files.map((f) => ({
      id: f.id,
      name: f.name,
      language: f.language,
      isDirty: f.isDirty,
      updatedAt: iso(f.updatedAt),
      content: cap(f.content),
      ...outputTail(f.id),
    })),
  };
}

function readFormatters(): Record<string, unknown> {
  const s = appStore();
  const forType = (type: "json" | "xml") => ({
    activeId: s.activeFormatterFileId[type],
    files: s.formatterFiles[type].map((f) => ({
      id: f.id,
      name: f.name,
      content: cap(f.content),
    })),
  });
  return { showing: s.formatterType, json: forType("json"), xml: forType("xml") };
}

function readComparators(): Record<string, unknown> {
  const s = appStore();
  return {
    activeId: s.activeComparatorSessionId,
    settings: s.comparatorSettings,
    sessions: s.comparatorSessions.map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode ?? "list",
      a: cap(c.a, SMALL_TEXT_CAP),
      b: cap(c.b, SMALL_TEXT_CAP),
    })),
  };
}

function readDiff(): Record<string, unknown> {
  const s = appStore();
  return {
    activeId: s.activeDiffSessionId,
    settings: s.diffSettings,
    sessions: s.diffSessions.map((d) => ({
      id: d.id,
      name: d.name,
      language: d.language,
      autoDetect: d.autoDetect ?? false,
      original: cap(d.original, SMALL_TEXT_CAP),
      modified: cap(d.modified, SMALL_TEXT_CAP),
    })),
  };
}

/** Headers as the model may see them: a secret header reports existence, not value */
function redactedHeaders(headers: readonly KeyValueField[]) {
  return headers.map((h) => ({
    key: h.key,
    enabled: h.enabled,
    value: isSecretHeader(h.key) ? masked(h.value) : h.value,
  }));
}

function redactedAuth(config: AuthConfig): Record<string, unknown> {
  return {
    ...config,
    bearerToken: masked(config.bearerToken),
    basicPassword: masked(config.basicPassword),
    apiKeyValue: masked(config.apiKeyValue),
  };
}

function redactedVars(vars: readonly KeyValueField[]) {
  return vars.map((v) => ({
    key: v.key,
    enabled: v.enabled,
    value: isSecretKey(v.key) ? masked(v.value) : v.value,
  }));
}

function readApiTester(): Record<string, unknown> {
  const s = apiStore();
  return {
    activeTabId: s.activeTabId,
    secretRule:
      "Values that look like credentials are reported as `•••• (N chars hidden)`. To use one in a request, reference it as a {{variable}} where the app substitutes values.",
    tabs: s.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      protocol: t.protocol,
      method: t.method,
      url: t.url,
      useProxy: t.useProxy,
      headers: redactedHeaders(t.headers),
      params: t.params.map((p) => ({ key: p.key, value: p.value, enabled: p.enabled })),
      bodyType: t.bodyType,
      body: cap(t.bodyValue, SMALL_TEXT_CAP),
      formParams: t.formParams.map((p) => ({ key: p.key, value: p.value, enabled: p.enabled })),
      authType: t.authType,
      auth: redactedAuth(t.authConfig),
      response: t.response
        ? {
            status: t.response.status,
            statusText: t.response.statusText,
            timeMs: t.response.time,
            size: t.response.size,
            body: cap(t.response.body, SMALL_TEXT_CAP),
          }
        : null,
      error: t.error,
    })),
    history: s.history.slice(0, HISTORY_LIMIT).map((h) => ({
      id: h.id,
      at: iso(h.timestamp),
      method: h.method,
      url: h.url,
      status: h.status,
      timeMs: h.time,
      failed: h.error ?? false,
      requestHeaders: h.headers ? h.headers.map((x) => ({ key: x.key, value: isSecretHeader(x.key) ? masked(x.value) : x.value })) : [],
      body: h.bodyValue ? cap(h.bodyValue, SMALL_TEXT_CAP) : "",
      auth: h.authConfig ? redactedAuth(h.authConfig) : undefined,
    })),
    collections: s.collections.map((c) => ({
      id: c.id,
      name: c.name,
      requests: c.requests.map((r) => ({ id: r.id, name: r.name, method: r.method, url: r.url })),
    })),
    globals: redactedVars(s.envVars),
    activeEnvironmentId: s.activeEnvironmentId,
    environments: s.environments.map((e: Environment) => ({
      id: e.id,
      name: e.name,
      variables: redactedVars(e.variables),
    })),
    customProxyUrl: s.customProxyUrl,
  };
}

function readLibrary(): Record<string, unknown> {
  const s = appStore();
  return {
    selectedItemId: s.librarySelectedItemId,
    searchQuery: s.librarySearchQuery,
    showing: s.libraryTab,
    drawFlowCategory: s.libraryDrawFlowCategory,
    excalidrawCategory: s.libraryExcalidrawCategory ?? "",
  };
}

function readDrawflows(): Record<string, unknown> {
  const s = appStore();
  return {
    activeWorkflowId: s.activeWorkflowId,
    boards: s.workflows.map((w) => ({
      id: w.id,
      name: w.name,
      elementCount: w.elements?.length ?? 0,
      updatedAt: iso(w.updatedAt),
    })),
  };
}

function readSettings(): Record<string, unknown> {
  const s = appStore();
  return {
    editor: s.editorSettings,
    comparator: s.comparatorSettings,
    diff: s.diffSettings,
    sidebarOpen: s.sidebarOpen,
    sidebarCollapsed: s.sidebarCollapsed,
    outputPanelOpen: s.outputPanelOpen,
  };
}

function readActivity(): Record<string, unknown> {
  return {
    actions: listAppActions().map((a) => ({
      id: a.id,
      family: a.family,
      action: a.action,
      summary: a.summary,
      at: iso(a.at),
      undone: a.undone,
    })),
  };
}

const READS: Record<string, () => Record<string, unknown>> = {
  editor: readEditor,
  formatters: readFormatters,
  comparators: readComparators,
  diff: readDiff,
  "api-tester": readApiTester,
  library: readLibrary,
  drawflows: readDrawflows,
  settings: readSettings,
  activity: readActivity,
};

/** Family ids, for the "did you mean" list */
function familyIds(): string {
  return APP_SURFACE.map((f) => f.id).join(", ");
}

/**
 * Reads one family.
 *
 * No argument returns the family INDEX rather than an error: the model asking
 * "what can I read" is a legitimate question, and answering it is one line per
 * family.
 */
export function readAppFamily(familyId?: string): AppReadOutcome {
  const id = familyId?.trim();
  if (!id) {
    return {
      ok: true,
      data: {
        families: APP_SURFACE.map((f) => ({
          id: f.id,
          label: f.label,
          reads: f.reads,
          actions: f.actions.map((a) => a.name),
          sensitivity: f.sensitivity,
        })),
        index: familyIndex(),
        note: "Read one with read_app({ family }), and load an action's argument shape with describe_tools({ family }).",
      },
      summary: `${APP_SURFACE.length} families`,
    };
  }
  const read = READS[id];
  if (!read) {
    return {
      ok: false,
      error: `No app family called "${id}". The families are: ${familyIds()}.`,
      summary: `unknown family: ${id}`,
    };
  }
  const family = appFamily(id)!;
  return { ok: true, data: read(), summary: `read ${family.label}` };
}

// ── api-tester: tab-scoped actions ───────────────────────────

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const BODY_TYPES: readonly BodyType[] = ["none", "json", "form-data", "raw"];
const AUTH_TYPES: readonly AuthType[] = ["none", "bearer", "basic", "api-key"];
const PROTOCOLS = ["rest", "graphql", "websocket"] as const;

/**
 * Runs `fn` against one tab, selecting it first when the caller named one.
 *
 * Most api-tester actions operate on the ACTIVE tab — that is how the UI works
 * and the store mirrors it — so acting on a named tab means selecting it,
 * acting, and putting the user's selection back. The `previousActiveId` is
 * handed to the callback because an undo must restore the selection too: an
 * undo that silently moves the user to another tab is a second change.
 */
function withTab<T>(
  tabIdArg: unknown,
  fn: (tab: TabState, ctx: { previousActiveId: string }) => T
): T {
  const store = apiStore();
  const previousActiveId = store.activeTabId;
  const requested = typeof tabIdArg === "string" ? tabIdArg.trim() : "";
  const targetId = requested || previousActiveId;
  const tab = store.tabs.find((t) => t.id === targetId);
  if (!tab) {
    throw noSuch("request tab", targetId, store.tabs.map((t) => t.id));
  }
  if (targetId !== previousActiveId) store.setActiveTab(targetId);
  try {
    return fn(tab, { previousActiveId });
  } finally {
    if (targetId !== previousActiveId) apiStore().setActiveTab(previousActiveId);
  }
}

/**
 * Puts one tab back exactly as it was.
 *
 * Direct state replacement is used because the store has no action that can
 * restore a tab wholesale, and a partial restore of a request (headers back but
 * body forward) is worse than none. The re-selection afterwards is what makes
 * the change persist: this store saves through its own calls, so re-selecting
 * the tab it is already on is the cheapest way to trigger the same save.
 */
function restoreTabSnapshot(snapshot: TabState, activeId: string): void {
  const store = apiStore();
  useApiTesterStore.setState({
    tabs: store.tabs.map((t) => (t.id === snapshot.id ? snapshot : t)),
    activeTabId: activeId,
  });
  apiStore().setActiveTab(activeId);
}

/** Finds a tab by id for the actions that address tabs directly (not via `withTab`) */
function requireTab(id: string): TabState {
  const store = apiStore();
  const tab = store.tabs.find((t) => t.id === id);
  if (!tab) throw noSuch("request tab", id, store.tabs.map((t) => t.id));
  return tab;
}

/** The variable list in a scope, with the environment resolved first */
function varScope(environmentIdArg: unknown): {
  environment: Environment | null;
  vars: readonly KeyValueField[];
  apply: (vars: KeyValueField[]) => void;
} {
  const raw = environmentIdArg;
  if (raw === undefined || raw === null || raw === "") {
    return {
      environment: null,
      vars: apiStore().envVars,
      apply: (vars) => apiStore().setEnvVars(vars),
    };
  }
  const id = typeof raw === "string" ? raw : "";
  const environment = apiStore().environments.find((e) => e.id === id);
  if (!environment) {
    throw noSuch("environment", id, apiStore().environments.map((e) => e.id));
  }
  return {
    environment,
    vars: environment.variables,
    apply: (vars) => apiStore().setEnvironmentVars(environment.id, vars),
  };
}

// ── Executors: one per declared action ───────────────────────

type ActionFn = (args: Record<string, unknown>) => Promise<Effect> | Effect;

const ACTIONS: Record<string, Record<string, ActionFn>> = {
  // ── editor: the app's own tabs ────────────────────────────
  editor: {
    create_file: (args) => {
      const name = requireString(args, "name");
      const language = requireLanguage(args, "language");
      const content = optionalString(args, "content");
      const before = new Set(appStore().files.map((f) => f.id));
      appStore().createFile(name, language, content);
      const created = appStore().files.find((f) => !before.has(f.id));
      if (!created) throw new AppActionError("The editor did not create a tab — nothing was changed.");
      return {
        data: { id: created.id, name: created.name, language },
        summary: `opened ${created.name}`,
        undo: () => appStore().deleteFile(created.id),
      };
    },

    update_content: (args) => {
      const file = requireFile(args.id);
      const content = requireString(args, "content", { allowEmpty: true });
      const mode = args.mode === "append" ? "append" : "replace";
      const previous = file.content;
      const next = mode === "append" ? previous + content : content;
      appStore().updateFileContent(file.id, next);
      return {
        data: { id: file.id, name: file.name, mode, characters: next.length },
        summary: `${mode === "append" ? "appended to" : "rewrote"} ${file.name}`,
        undo: () => appStore().updateFileContent(file.id, previous),
      };
    },

    rename_file: (args) => {
      const file = requireFile(args.id);
      const name = requireString(args, "name");
      const previous = file.name;
      appStore().renameFile(file.id, name);
      return {
        data: { id: file.id, name },
        summary: `renamed ${previous} → ${name}`,
        undo: () => appStore().renameFile(file.id, previous),
      };
    },

    duplicate_file: (args) => {
      const file = requireFile(args.id);
      const before = new Set(appStore().files.map((f) => f.id));
      appStore().duplicateFile(file.id);
      const copy = appStore().files.find((f) => !before.has(f.id));
      if (!copy) throw new AppActionError("The editor did not duplicate the tab.");
      return {
        data: { id: copy.id, name: copy.name, from: file.id },
        summary: `duplicated ${file.name}`,
        undo: () => appStore().deleteFile(copy.id),
      };
    },

    delete_file: (args) => {
      const file = requireFile(args.id);
      const state = appStore();
      const files = state.files;
      const activeFileId = state.activeFileId;
      const exec = state.tabExec[file.id];
      state.deleteFile(file.id);
      return {
        data: { id: file.id, name: file.name },
        summary: `closed and discarded ${file.name}`,
        // The whole file list is restored, because the store's own action
        // deletes the tab's console state along with it and there is no action
        // that reinserts a file by object. An undo immediately after the
        // delete is the case this is for, which is why the snapshot is taken
        // at the moment of the change.
        undo: () => {
          const next: Record<string, unknown> = { files, activeFileId };
          if (exec) next.tabExec = { ...appStore().tabExec, [file.id]: exec };
          useAppStore.setState(next);
        },
      };
    },

    set_active_file: (args) => {
      const file = requireFile(args.id);
      const previous = appStore().activeFileId;
      appStore().setActiveFile(file.id);
      return {
        data: { id: file.id, name: file.name },
        summary: `focused ${file.name}`,
        undo: previous ? () => appStore().setActiveFile(previous) : undefined,
      };
    },

    set_stdin: (args) => {
      const file = requireFile(args.id);
      const stdin = requireString(args, "stdin", { allowEmpty: true });
      const previous = appStore().tabExec[file.id]?.stdin ?? "";
      appStore().setTabStdin(file.id, stdin);
      return {
        data: { id: file.id, name: file.name, characters: stdin.length },
        summary: `set stdin for ${file.name}`,
        undo: () => appStore().setTabStdin(file.id, previous),
      };
    },

    run_file: async (args) => {
      const file = requireFile(args.id);
      await appStore().runFile(file.id);
      const exec = appStore().tabExec[file.id];
      const last = exec?.executionResults?.[exec.executionResults.length - 1];
      // No ledger row: a run appends to a console the user can clear and
      // changes nothing they typed. Undoing it would mean deleting output that
      // may have been there before, which is a second change, not a reversal.
      return {
        data: {
          id: file.id,
          name: file.name,
          exitCode: last?.exitCode,
          durationMs: last?.duration,
          stdout: cap(last?.stdout ?? "", 3_000),
          stderr: cap(last?.stderr ?? "", 2_000),
          ...outputTail(file.id),
        },
        summary: `ran ${file.name}`,
      };
    },
  },

  // ── formatters ────────────────────────────────────────────
  formatters: {
    create_file: (args) => {
      const type = requireFormatType(args);
      const name = optionalString(args, "name");
      const content = optionalString(args, "content");
      const before = new Set(appStore().formatterFiles[type].map((f) => f.id));
      appStore().createFormatterFile(type, name);
      const created = appStore().formatterFiles[type].find((f) => !before.has(f.id));
      if (!created) throw new AppActionError(`The ${type} formatter did not create a tab.`);
      if (content !== undefined) appStore().updateFormatterFileContent(type, created.id, content);
      return {
        data: { formatType: type, id: created.id, name: created.name },
        summary: `opened ${type} tab ${created.name}`,
        undo: () => appStore().deleteFormatterFile(type, created.id),
      };
    },

    update_content: (args) => {
      const type = requireFormatType(args);
      const file = requireFormatterFile(type, args.id);
      const content = requireString(args, "content", { allowEmpty: true });
      const previous = file.content;
      appStore().updateFormatterFileContent(type, file.id, content);
      return {
        data: { formatType: type, id: file.id, characters: content.length },
        summary: `rewrote ${file.name}`,
        undo: () => appStore().updateFormatterFileContent(type, file.id, previous),
      };
    },

    rename_file: (args) => {
      const type = requireFormatType(args);
      const file = requireFormatterFile(type, args.id);
      const name = requireString(args, "name");
      const previous = file.name;
      appStore().renameFormatterFile(type, file.id, name);
      return {
        data: { formatType: type, id: file.id, name },
        summary: `renamed ${previous} → ${name}`,
        undo: () => appStore().renameFormatterFile(type, file.id, previous),
      };
    },

    duplicate_file: (args) => {
      const type = requireFormatType(args);
      const file = requireFormatterFile(type, args.id);
      const before = new Set(appStore().formatterFiles[type].map((f) => f.id));
      appStore().duplicateFormatterFile(type, file.id);
      const copy = appStore().formatterFiles[type].find((f) => !before.has(f.id));
      if (!copy) throw new AppActionError(`The ${type} formatter did not duplicate the tab.`);
      return {
        data: { formatType: type, id: copy.id, from: file.id },
        summary: `duplicated ${file.name}`,
        undo: () => appStore().deleteFormatterFile(type, copy.id),
      };
    },

    set_active: (args) => {
      const type = requireFormatType(args);
      const file = requireFormatterFile(type, args.id);
      const state = appStore();
      const previousActive = state.activeFormatterFileId[type];
      const previousType = state.formatterType;
      state.setActiveFormatterFile(type, file.id);
      state.setFormatterType(type);
      return {
        data: { formatType: type, id: file.id },
        summary: `focused ${file.name}`,
        undo: () => {
          appStore().setActiveFormatterFile(type, previousActive);
          appStore().setFormatterType(previousType);
        },
      };
    },

    delete_file: (args) => {
      const type = requireFormatType(args);
      const file = requireFormatterFile(type, args.id);
      const state = appStore();
      const files = state.formatterFiles[type];
      const activeId = state.activeFormatterFileId[type];
      state.deleteFormatterFile(type, file.id);
      return {
        data: { formatType: type, id: file.id, name: file.name },
        summary: `closed and discarded ${file.name}`,
        undo: () =>
          useAppStore.setState({
            formatterFiles: { ...appStore().formatterFiles, [type]: files },
            activeFormatterFileId: { ...appStore().activeFormatterFileId, [type]: activeId },
          }),
      };
    },
  },

  // ── comparators ───────────────────────────────────────────
  comparators: {
    create: (args) => {
      const name = optionalString(args, "name");
      const mode = optionalString(args, "mode");
      const before = new Set(appStore().comparatorSessions.map((c) => c.id));
      appStore().createComparatorSession(
        name,
        mode === "json" || mode === "env" || mode === "list" ? mode : undefined
      );
      const created = appStore().comparatorSessions.find((c) => !before.has(c.id));
      if (!created) throw new AppActionError("No comparison was created.");
      return {
        data: { id: created.id, name: created.name, mode: created.mode ?? "list" },
        summary: `started comparison ${created.name}`,
        undo: () => appStore().deleteComparatorSession(created.id),
      };
    },

    update_input: (args) => {
      const session = requireComparator(args.id);
      const side = requireEnum(args, "side", ["a", "b"] as const);
      const input = requireString(args, "input", { allowEmpty: true });
      const previous = side === "a" ? session.a : session.b;
      appStore().updateComparatorSessionInput(session.id, side, input);
      return {
        data: { id: session.id, side, characters: input.length },
        summary: `set side ${side} of ${session.name}`,
        undo: () => appStore().updateComparatorSessionInput(session.id, side, previous),
      };
    },

    swap_inputs: (args) => {
      const session = requireComparator(args.id);
      appStore().swapComparatorSessionInputs(session.id);
      return {
        data: { id: session.id },
        summary: `swapped sides of ${session.name}`,
        undo: () => appStore().swapComparatorSessionInputs(session.id),
      };
    },

    set_mode: (args) => {
      const session = requireComparator(args.id);
      const mode = requireEnum(args, "mode", ["list", "json", "env"] as const);
      const previous = session.mode ?? "list";
      appStore().updateComparatorSessionMode(session.id, mode);
      return {
        data: { id: session.id, mode },
        summary: `${session.name} → ${mode} mode`,
        undo: () => appStore().updateComparatorSessionMode(session.id, previous),
      };
    },

    rename: (args) => {
      const session = requireComparator(args.id);
      const name = requireString(args, "name");
      const previous = session.name;
      appStore().renameComparatorSession(session.id, name);
      return {
        data: { id: session.id, name },
        summary: `renamed ${previous} → ${name}`,
        undo: () => appStore().renameComparatorSession(session.id, previous),
      };
    },

    duplicate: (args) => {
      const session = requireComparator(args.id);
      const before = new Set(appStore().comparatorSessions.map((c) => c.id));
      appStore().duplicateComparatorSession(session.id);
      const copy = appStore().comparatorSessions.find((c) => !before.has(c.id));
      if (!copy) throw new AppActionError("The comparison was not duplicated.");
      return {
        data: { id: copy.id, from: session.id },
        summary: `duplicated ${session.name}`,
        undo: () => appStore().deleteComparatorSession(copy.id),
      };
    },

    set_active: (args) => {
      const session = requireComparator(args.id);
      const previous = appStore().activeComparatorSessionId;
      appStore().setActiveComparatorSession(session.id);
      return {
        data: { id: session.id },
        summary: `focused ${session.name}`,
        undo: () => appStore().setActiveComparatorSession(previous),
      };
    },

    delete: (args) => {
      const session = requireComparator(args.id);
      const state = appStore();
      const sessions = state.comparatorSessions;
      const activeId = state.activeComparatorSessionId;
      state.deleteComparatorSession(session.id);
      return {
        data: { id: session.id, name: session.name },
        summary: `discarded comparison ${session.name}`,
        undo: () =>
          useAppStore.setState({ comparatorSessions: sessions, activeComparatorSessionId: activeId }),
      };
    },

    update_settings: (args) => {
      const patch: Record<string, boolean> = {};
      for (const key of ["caseSensitive", "trimWhitespace", "sortAlpha"] as const) {
        if (typeof args[key] === "boolean") patch[key] = args[key] as boolean;
      }
      if (Object.keys(patch).length === 0) {
        throw new AppActionError("update_settings needs at least one of caseSensitive, trimWhitespace, sortAlpha.");
      }
      const before = appStore().comparatorSettings;
      const previous: Record<string, boolean> = {};
      for (const key of Object.keys(patch)) previous[key] = before[key as keyof typeof before];
      appStore().updateComparatorSettings(patch);
      return {
        data: { changed: patch },
        summary: `comparison settings: ${Object.keys(patch).join(", ")}`,
        undo: () => appStore().updateComparatorSettings(previous),
      };
    },
  },

  // ── diff ──────────────────────────────────────────────────
  diff: {
    create: (args) => {
      const name = optionalString(args, "name");
      const before = new Set(appStore().diffSessions.map((d) => d.id));
      appStore().createDiffSession(name);
      const created = appStore().diffSessions.find((d) => !before.has(d.id));
      if (!created) throw new AppActionError("No diff was created.");
      return {
        data: { id: created.id, name: created.name },
        summary: `started diff ${created.name}`,
        undo: () => appStore().deleteDiffSession(created.id),
      };
    },

    update_input: (args) => {
      const session = requireDiff(args.id);
      const side = requireEnum(args, "side", ["original", "modified"] as const);
      const input = requireString(args, "input", { allowEmpty: true });
      const previous = side === "original" ? session.original : session.modified;
      appStore().updateDiffSessionInput(session.id, side, input);
      return {
        data: { id: session.id, side, characters: input.length },
        summary: `set ${side} of ${session.name}`,
        undo: () => appStore().updateDiffSessionInput(session.id, side, previous),
      };
    },

    set_language: (args) => {
      const session = requireDiff(args.id);
      const language = requireString(args, "language");
      const autoDetect = typeof args.autoDetect === "boolean" ? (args.autoDetect as boolean) : undefined;
      const previous = { language: session.language, autoDetect: session.autoDetect ?? false };
      appStore().updateDiffSessionLanguage(session.id, language, autoDetect);
      return {
        data: { id: session.id, language },
        summary: `${session.name}: ${language}`,
        undo: () => appStore().updateDiffSessionLanguage(session.id, previous.language, previous.autoDetect),
      };
    },

    rename: (args) => {
      const session = requireDiff(args.id);
      const name = requireString(args, "name");
      const previous = session.name;
      appStore().renameDiffSession(session.id, name);
      return {
        data: { id: session.id, name },
        summary: `renamed ${previous} → ${name}`,
        undo: () => appStore().renameDiffSession(session.id, previous),
      };
    },

    duplicate: (args) => {
      const session = requireDiff(args.id);
      const before = new Set(appStore().diffSessions.map((d) => d.id));
      appStore().duplicateDiffSession(session.id);
      const copy = appStore().diffSessions.find((d) => !before.has(d.id));
      if (!copy) throw new AppActionError("The diff was not duplicated.");
      return {
        data: { id: copy.id, from: session.id },
        summary: `duplicated ${session.name}`,
        undo: () => appStore().deleteDiffSession(copy.id),
      };
    },

    set_active: (args) => {
      const session = requireDiff(args.id);
      const previous = appStore().activeDiffSessionId;
      appStore().setActiveDiffSession(session.id);
      return {
        data: { id: session.id },
        summary: `focused ${session.name}`,
        undo: () => appStore().setActiveDiffSession(previous),
      };
    },

    delete: (args) => {
      const session = requireDiff(args.id);
      const state = appStore();
      const sessions = state.diffSessions;
      const activeId = state.activeDiffSessionId;
      state.deleteDiffSession(session.id);
      return {
        data: { id: session.id, name: session.name },
        summary: `discarded diff ${session.name}`,
        undo: () => useAppStore.setState({ diffSessions: sessions, activeDiffSessionId: activeId }),
      };
    },

    update_settings: (args) => {
      const patch: Record<string, boolean> = {};
      for (const key of [
        "renderSideBySide",
        "ignoreTrimWhitespace",
        "wordWrap",
        "autoFormatOnPaste",
        "enableSplitViewResizing",
      ] as const) {
        if (typeof args[key] === "boolean") patch[key] = args[key] as boolean;
      }
      if (Object.keys(patch).length === 0) {
        throw new AppActionError("update_settings needs at least one diff setting to change.");
      }
      const before = appStore().diffSettings;
      const previous: Record<string, boolean> = {};
      for (const key of Object.keys(patch)) previous[key] = before[key as keyof typeof before] ?? false;
      appStore().updateDiffSettings(patch);
      return {
        data: { changed: patch },
        summary: `diff settings: ${Object.keys(patch).join(", ")}`,
        undo: () => appStore().updateDiffSettings(previous),
      };
    },
  },

  // ── api-tester ────────────────────────────────────────────
  "api-tester": {
    create_tab: () => {
      const before = new Set(apiStore().tabs.map((t) => t.id));
      apiStore().addTab();
      const created = apiStore().tabs.find((t) => !before.has(t.id));
      if (!created) throw new AppActionError("No request tab was created.");
      return {
        data: { id: created.id, name: created.name },
        summary: `opened request tab ${created.name}`,
        undo: () => apiStore().removeTab(created.id),
      };
    },

    set_active_tab: (args) => {
      const tab = requireTab(requireString(args, "id"));
      const previous = apiStore().activeTabId;
      apiStore().setActiveTab(tab.id);
      return {
        data: { id: tab.id, name: tab.name },
        summary: `focused request tab ${tab.name}`,
        undo: () => apiStore().setActiveTab(previous),
      };
    },

    rename_tab: (args) => {
      const tab = requireTab(requireString(args, "id"));
      const name = requireString(args, "name");
      const previous = tab.name;
      apiStore().renameTab(tab.id, name);
      return {
        data: { id: tab.id, name },
        summary: `renamed ${previous} → ${name}`,
        undo: () => apiStore().renameTab(tab.id, previous),
      };
    },

    set_request: (args) =>
      withTab(args.tabId, (tab, ctx) => {
        const applied: string[] = [];
        if (args.method !== undefined) {
          apiStore().setMethod(requireEnum(args, "method", HTTP_METHODS));
          applied.push("method");
        }
        if (args.url !== undefined) {
          apiStore().setUrl(requireString(args, "url", { allowEmpty: true }));
          applied.push("url");
        }
        if (args.bodyType !== undefined) {
          apiStore().setBodyType(requireEnum(args, "bodyType", BODY_TYPES));
          applied.push("bodyType");
        }
        if (args.body !== undefined) {
          apiStore().setBodyValue(requireString(args, "body", { allowEmpty: true }));
          applied.push("body");
        }
        if (args.protocol !== undefined) {
          apiStore().setProtocol(requireEnum(args, "protocol", PROTOCOLS));
          applied.push("protocol");
        }
        if (args.useProxy !== undefined) {
          if (typeof args.useProxy !== "boolean") {
            throw new AppActionError("`useProxy` must be a boolean.");
          }
          apiStore().setUseProxy(args.useProxy);
          applied.push("useProxy");
        }
        if (applied.length === 0) {
          throw new AppActionError(
            "set_request needs at least one of method, url, bodyType, body, protocol, useProxy."
          );
        }
        return {
          data: { tabId: tab.id, name: tab.name, changed: applied },
          summary: `${tab.name}: ${applied.join(", ")}`,
          undo: () => restoreTabSnapshot(tab, ctx.previousActiveId),
        };
      }),

    set_header: (args) =>
      withTab(args.tabId, (tab, ctx) => {
        const key = requireString(args, "key");
        const value = requireString(args, "value", { allowEmpty: true, what: "the header value" });
        const existing = tab.headers.find((h) => h.key.trim() !== "" && h.key.toLowerCase() === key.toLowerCase());
        const before = new Set(tab.headers.map((h) => h.id));
        if (existing) {
          apiStore().updateHeader(existing.id, { value, enabled: true });
        } else {
          apiStore().addHeader();
          const added = apiStore()
            .tabs.find((t) => t.id === tab.id)!
            .headers.find((h) => !before.has(h.id));
          if (!added) throw new AppActionError("Could not add a header row.");
          apiStore().updateHeader(added.id, { key, value, enabled: true });
        }
        return {
          data: {
            tabId: tab.id,
            key,
            value: isSecretHeader(key) ? masked(value) : value,
            replaced: Boolean(existing),
          },
          summary: `${existing ? "set" : "added"} header ${key}`,
          undo: () => restoreTabSnapshot(tab, ctx.previousActiveId),
        };
      }),

    remove_header: (args) =>
      withTab(args.tabId, (tab, ctx) => {
        const key = requireString(args, "key");
        const existing = tab.headers.find((h) => h.key.trim() !== "" && h.key.toLowerCase() === key.toLowerCase());
        if (!existing) {
          const known = tab.headers.filter((h) => h.key.trim() !== "").map((h) => h.key);
          throw new AppActionError(
            `Tab "${tab.name}" has no header called "${key}".${known.length ? ` It has: ${known.join(", ")}.` : " It has no headers yet."}`
          );
        }
        apiStore().removeHeader(existing.id);
        return {
          data: { tabId: tab.id, key },
          summary: `removed header ${key}`,
          undo: () => restoreTabSnapshot(tab, ctx.previousActiveId),
        };
      }),

    set_auth: (args) =>
      withTab(args.tabId, (tab, ctx) => {
        const type = requireEnum(args, "type", AUTH_TYPES);
        const config = args.config;
        if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
          throw new AppActionError("`config` must be an object, e.g. { bearerToken: \"{{API_TOKEN}}\" }.");
        }
        apiStore().setAuthType(type);
        if (config) apiStore().setAuthConfig(config as Partial<AuthConfig>);
        const secretFieldsTouched = config
          ? Object.entries(config as Record<string, unknown>)
              .filter(([k, v]) => isSecretKey(k) && typeof v === "string" && v !== "")
              .map(([k]) => k)
          : [];
        return {
          data: { tabId: tab.id, type, configured: config ? Object.keys(config) : [], secretFieldsTouched },
          summary: `${tab.name}: auth ${type}`,
          undo: () => restoreTabSnapshot(tab, ctx.previousActiveId),
        };
      }),

    add_environment: (args) => {
      const name = requireString(args, "name");
      const id = apiStore().addEnvironment(name);
      return {
        data: { id, name },
        summary: `created environment ${name}`,
        undo: () => apiStore().removeEnvironment(id),
      };
    },

    rename_environment: (args) => {
      const id = requireString(args, "id");
      const environment = apiStore().environments.find((e) => e.id === id);
      if (!environment) throw noSuch("environment", id, apiStore().environments.map((e) => e.id));
      const name = requireString(args, "name");
      const previous = environment.name;
      apiStore().updateEnvironment(id, name);
      return {
        data: { id, name },
        summary: `renamed environment ${previous} → ${name}`,
        undo: () => apiStore().updateEnvironment(id, previous),
      };
    },

    set_active_environment: (args) => {
      const raw = args.id;
      const id = raw === null || raw === "" ? null : requireString(args, "id");
      if (id && !apiStore().environments.some((e) => e.id === id)) {
        throw noSuch("environment", id, apiStore().environments.map((e) => e.id));
      }
      const previous = apiStore().activeEnvironmentId;
      apiStore().setActiveEnvironment(id);
      return {
        data: { activeEnvironmentId: id },
        summary: id ? "selected an environment" : "cleared the active environment",
        undo: () => apiStore().setActiveEnvironment(previous),
      };
    },

    set_var: (args) => {
      const scope = varScope(args.environmentId);
      const key = requireString(args, "key");
      const remove = args.remove === true;
      const value = optionalString(args, "value");
      if (!remove && value === undefined) {
        throw new AppActionError("set_var needs `value`, or `remove: true` to clear the key.");
      }
      const existing = scope.vars.find((v) => v.key.trim().toLowerCase() === key.trim().toLowerCase());
      let next: KeyValueField[];
      if (remove) {
        if (!existing) {
          const known = scope.vars.filter((v) => v.key.trim() !== "").map((v) => v.key);
          throw new AppActionError(
            `No variable called "${key}" in ${scope.environment ? `environment "${scope.environment.name}"` : "the global variables"}.${
              known.length ? ` Known keys: ${known.join(", ")}.` : ""
            }`
          );
        }
        next = scope.vars.filter((v) => v.id !== existing.id);
      } else if (existing) {
        next = scope.vars.map((v) => (v.id === existing.id ? { ...v, value: value! } : v));
      } else {
        next = [...scope.vars, { id: fieldId(), key, value: value!, enabled: true }];
      }
      const previous = [...scope.vars];
      scope.apply(next);
      const where = scope.environment ? `environment ${scope.environment.name}` : "global variables";
      return {
        data: {
          scope: where,
          key,
          removed: remove,
          value: remove ? undefined : isSecretKey(key) ? masked(value!) : value,
        },
        summary: remove ? `cleared ${key} in ${where}` : `set ${key} in ${where}`,
        undo: () => scope.apply(previous),
      };
    },
  },

  // ── library ───────────────────────────────────────────────
  library: {
    select_item: (args) => {
      const raw = args.id;
      const id = raw === null || raw === "" ? null : requireString(args, "id");
      const previous = appStore().librarySelectedItemId;
      appStore().setLibrarySelectedItemId(id);
      return {
        data: { selectedItemId: id },
        summary: id ? `selected library item ${id}` : "cleared the library selection",
        undo: () => appStore().setLibrarySelectedItemId(previous),
      };
    },

    search: (args) => {
      const query = requireString(args, "query", { allowEmpty: true });
      const tab = optionalString(args, "tab");
      const previousQuery = appStore().librarySearchQuery;
      const previousTab = appStore().libraryTab;
      appStore().setLibrarySearchQuery(query);
      if (tab === "servicenow" || tab === "drawflow" || tab === "excalidraw") appStore().setLibraryTab(tab);
      return {
        data: { query, showing: tab ?? previousTab },
        summary: query === "" ? "cleared the library search" : `searched the library for "${query}"`,
        undo: () => {
          appStore().setLibrarySearchQuery(previousQuery);
          appStore().setLibraryTab(previousTab);
        },
      };
    },

    set_tab: (args) => {
      const tab = requireEnum(args, "tab", ["servicenow", "drawflow", "excalidraw"] as const);
      const previous = appStore().libraryTab;
      appStore().setLibraryTab(tab);
      return {
        data: { showing: tab },
        summary: `library: ${tab}`,
        undo: () => appStore().setLibraryTab(previous),
      };
    },

    set_category: (args) => {
      const category = requireString(args, "category", { allowEmpty: true });
      const state = appStore();
      const previousDrawFlow = state.libraryDrawFlowCategory;
      const previousExcalidraw = state.libraryExcalidrawCategory ?? "";
      if (state.libraryTab === "excalidraw") state.setLibraryExcalidrawCategory(category);
      else state.setLibraryDrawFlowCategory(category);
      return {
        data: { showing: state.libraryTab, category },
        summary: `library category: ${category || "(all)"}`,
        undo: () => {
          appStore().setLibraryDrawFlowCategory(previousDrawFlow);
          appStore().setLibraryExcalidrawCategory(previousExcalidraw);
        },
      };
    },
  },

  // ── drawflows ─────────────────────────────────────────────
  drawflows: {
    create_board: (args) => {
      const name = optionalString(args, "name");
      const id = appStore().createWorkflow(name);
      return {
        data: { id },
        summary: `created board ${name ?? id}`,
        undo: () => appStore().deleteWorkflow(id),
      };
    },

    rename_board: (args) => {
      const board = requireBoard(args.id);
      const name = requireString(args, "name");
      const previous = board.name;
      appStore().renameWorkflow(board.id, name);
      return {
        data: { id: board.id, name },
        summary: `renamed board ${previous} → ${name}`,
        undo: () => appStore().renameWorkflow(board.id, previous),
      };
    },

    duplicate_board: (args) => {
      const board = requireBoard(args.id);
      const before = new Set(appStore().workflows.map((w) => w.id));
      appStore().duplicateWorkflow(board.id);
      const copy = appStore().workflows.find((w) => !before.has(w.id));
      if (!copy) throw new AppActionError("The board was not duplicated.");
      return {
        data: { id: copy.id, from: board.id },
        summary: `duplicated board ${board.name}`,
        undo: () => appStore().deleteWorkflow(copy.id),
      };
    },

    set_active_board: (args) => {
      const board = requireBoard(args.id);
      const previous = appStore().activeWorkflowId;
      appStore().setActiveWorkflow(board.id);
      return {
        data: { id: board.id },
        summary: `focused board ${board.name}`,
        undo: () => appStore().setActiveWorkflow(previous),
      };
    },

    delete_board: (args) => {
      const board = requireBoard(args.id);
      const state = appStore();
      const workflows = state.workflows;
      const activeId = state.activeWorkflowId;
      state.deleteWorkflow(board.id);
      return {
        data: { id: board.id, name: board.name },
        summary: `discarded board ${board.name}`,
        undo: () => useAppStore.setState({ workflows, activeWorkflowId: activeId }),
      };
    },
  },

  // ── settings ──────────────────────────────────────────────
  settings: {
    update_editor: (args) => {
      const before = appStore().editorSettings;
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== typeof before[key]) {
          throw new AppActionError(
            `\`${key}\` must be of type ${typeof before[key]} (currently ${JSON.stringify(before[key])}).`
          );
        }
        patch[key] = args[key];
      }
      if (Object.keys(patch).length === 0) {
        throw new AppActionError(
          `Nothing to change. Editor settings are: ${Object.keys(before).join(", ")}.`
        );
      }
      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) previous[key] = before[key as keyof typeof before];
      appStore().updateEditorSettings(patch);
      return {
        data: { changed: patch },
        summary: `editor settings: ${Object.keys(patch).join(", ")}`,
        undo: () => appStore().updateEditorSettings(previous),
      };
    },

    toggle_panel: (args) => {
      const panel = requireEnum(args, "panel", ["sidebar", "output"] as const);
      if (typeof args.open !== "boolean") throw new AppActionError("`open` must be a boolean.");
      const open = args.open;
      if (panel === "sidebar") {
        const was = appStore().sidebarOpen;
        if (was !== open) appStore().toggleSidebar();
        return {
          data: { panel, open },
          summary: `${open ? "opened" : "closed"} the sidebar`,
          undo: () => {
            if (was !== open) appStore().toggleSidebar();
          },
        };
      }
      const was = appStore().outputPanelOpen;
      appStore().setOutputPanelOpen(open);
      return {
        data: { panel, open },
        summary: `${open ? "opened" : "closed"} the output panel`,
        undo: () => appStore().setOutputPanelOpen(was),
      };
    },
  },

  // ── activity ──────────────────────────────────────────────
  activity: {
    undo: (args) => {
      const id = requireString(args, "id");
      const outcome = undoAppAction(id);
      if (!outcome.ok) throw new AppActionError(outcome.error);
      return {
        data: { id, undone: true, was: outcome.record.summary },
        summary: `undid ${outcome.record.summary}`,
      };
    },
  },
};

// ── Requirement helpers (store lookups with named misses) ─────

function requireFile(idArg: unknown) {
  const id = typeof idArg === "string" ? idArg : "";
  const file = appStore().files.find((f) => f.id === id);
  if (!file) throw noSuch("editor tab", id, appStore().files.map((f) => f.id));
  return file;
}

function requireFormatType(args: Record<string, unknown>): "json" | "xml" {
  return requireEnum(args, "formatType", ["json", "xml"] as const);
}

function requireFormatterFile(type: "json" | "xml", idArg: unknown) {
  const id = typeof idArg === "string" ? idArg : "";
  const file = appStore().formatterFiles[type].find((f) => f.id === id);
  if (!file) throw noSuch(`${type} formatter tab`, id, appStore().formatterFiles[type].map((f) => f.id));
  return file;
}

function requireComparator(idArg: unknown) {
  const id = typeof idArg === "string" ? idArg : "";
  const session = appStore().comparatorSessions.find((c) => c.id === id);
  if (!session) throw noSuch("comparison session", id, appStore().comparatorSessions.map((c) => c.id));
  return session;
}

function requireDiff(idArg: unknown) {
  const id = typeof idArg === "string" ? idArg : "";
  const session = appStore().diffSessions.find((d) => d.id === id);
  if (!session) throw noSuch("diff session", id, appStore().diffSessions.map((d) => d.id));
  return session;
}

function requireBoard(idArg: unknown) {
  const id = typeof idArg === "string" ? idArg : "";
  const board = appStore().workflows.find((w) => w.id === id);
  if (!board) throw noSuch("board", id, appStore().workflows.map((w) => w.id));
  return board;
}

// ── Dispatch ─────────────────────────────────────────────────

/** True when a family/action pair has an executor — the catalog/executor invariant */
export function hasAppActionExecutor(familyId: string, action: string): boolean {
  return Boolean(ACTIONS[familyId]?.[action]);
}

/** Every action a family declares, whether or not an executor exists (for tests) */
export function declaredActions(familyId: string): string[] {
  return appFamily(familyId)?.actions.map((a) => a.name) ?? [];
}

/**
 * Every action a family has an EXECUTOR for.
 *
 * Exported so the agreement between the catalog and this module can be tested
 * in both directions: an action declared with no executor is a promise the
 * agent cannot keep, and an executor nobody declared is reachable only by
 * guessing — the same failure the registry/dispatcher test exists for.
 */
export function executorActions(familyId: string): string[] {
  return Object.keys(ACTIONS[familyId] ?? {});
}

/**
 * Runs one declared action.
 *
 * Never throws: a bad argument, a missing id or a store refusal comes back as a
 * result the model can read and correct — the same contract every other tool in
 * this app keeps. A successful write is recorded in the action ledger with the
 * reversal the executor captured, which is what makes "act by default"
 * defensible: the user can always put it back, and the agent can too.
 */
export async function runAppAction(
  familyId: string,
  action: string,
  args: Record<string, unknown> = {},
  /** The conversation whose agent acts — stamps the undo ledger, so a scoped release (thread deleted) drops only its records */
  threadId?: string
): Promise<AppActOutcome> {
  const family = appFamily(familyId);
  if (!family) {
    return {
      ok: false,
      error: `No app family called "${familyId}". The families are: ${familyIds()}.`,
      summary: `unknown family: ${familyId}`,
    };
  }
  const executor = ACTIONS[family.id]?.[action];
  if (!executor) {
    const known = family.actions.map((a) => a.name);
    // drawflows is the one family a confused model mistakes for a drawing
    // surface: its only write action makes an EMPTY board, so a model that
    // wants nodes tries `add_node`/`add_element` and dead-ends here. The
    // board-drawing tool is `create_diagram`, and it is offered wherever
    // act_app is (both are app tools), so naming it is always actionable.
    const drawHint =
      family.id === "drawflows"
        ? ' To DRAW a new board — its nodes and arrows — use the `create_diagram` tool; this family only manages boards that already exist.'
        : "";
    return {
      ok: false,
      error: `Family "${family.id}" has no action called "${action}". Its actions: ${known.join(", ")}.${drawHint}`,
      summary: `${family.id}: unknown action ${action}`,
    };
  }
  try {
    const effect = await executor(args);
    const declared = family.actions.find((a) => a.name === action);
    if (declared?.writes && effect.undo && family.id !== "activity") {
      recordAppAction({
        family: family.id,
        action,
        summary: effect.summary,
        undo: effect.undo,
        threadId,
      });
    }
    return { ok: true, data: effect.data, summary: effect.summary };
  } catch (err) {
    const message =
      err instanceof AppActionError
        ? err.message
        : `The app refused the change: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, error: message, summary: `${family.id}.${action} failed` };
  }
}

/**
 * The catalog detail for one family or all of them — what `describe_tools`
 * returns, and the reason the wire can stay small: thirty family ids cost three
 * tool schemas, and the argument shapes arrive when the turn needs them.
 */
export function describeToolFamilies(ids?: readonly string[]): {
  text: string;
  unknown: string[];
} {
  return describeFamilies(ids);
}
