// ============================================================
// Tool Registry — One Declarative Table for Every Agent Tool
// ============================================================
// Inspired by DeepSeek Harness's "everything is a plugin" tool
// registry: each tool is ONE record here — its wire schema, its
// execution kind, its cacheability, and its activity-row summarizer
// — instead of being spread across a schema list, a name set, a
// bridge set, a cacheability set, and a summarize switch.
//
// Adding a tool = adding one entry below (+ an executor in the
// matching module: read/program tools execute in lib/tools.ts,
// bridge tools in services/agent-actions.ts).
//
// This module is a LEAF: it imports types only, so every layer
// (runner, cache, program interpreter, UI) can read from it
// without cycles. Strict per-tool argument validation happens
// here before execution so a malformed model call fails fast with
// a precise, self-correcting error instead of a vague executor
// failure late in the loop.
//
// UI-free and side-effect-free.

import type { RepoContext, ToolDefinition, ToolName } from "../types";

// ── Mini JSON-Schema subset (model argument validation) ──────

export type ArgSchemaType = "string" | "number" | "boolean" | "object" | "array";

export interface ArgSchema {
  type: ArgSchemaType;
  description?: string;
  /** Restricted value set (validated) */
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  /** For type "object": property schemas */
  properties?: Record<string, ArgSchema>;
  /** For type "object": keys that must be present */
  required?: string[];
  /** For type "array": element schema */
  items?: ArgSchema;
  /** For type "array": maximum element count */
  maxItems?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(value: unknown, type: ArgSchemaType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
  }
}

/** Human name for a typeof failure message */
function typeName(type: ArgSchemaType): string {
  return type;
}

/**
 * Validates one value against a property schema. Returns the first
 * error message, or null when valid. Unknown extra properties on
 * object args are ignored (provider-forward-compatible); known
 * properties are validated strictly.
 */
function validateValue(name: string, value: unknown, schema: ArgSchema): string | null {
  if (value === undefined || value === null) {
    return `Argument "${name}" must not be ${value === undefined ? "undefined" : "null"}.`;
  }
  if (!typeMatches(value, schema.type)) {
    const got = Array.isArray(value) ? "array" : typeof value;
    return `Argument "${name}" must be of type ${typeName(schema.type)}, got ${got}.`;
  }
  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    return `Argument "${name}" must be one of: ${schema.enum.map((e) => `"${e}"`).join(", ")}.`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `Argument "${name}" must be at least ${schema.minLength} character(s).`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `Argument "${name}" exceeds the maximum length of ${schema.maxLength} characters.`;
    }
  }
  if (isRecord(value) && schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      const err = validateValue(`${name}.${key}`, value[key], sub);
      if (err) return err;
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `Argument "${name}" has ${value.length} items; the maximum is ${schema.maxItems}.`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateValue(`${name}[${i}]`, value[i], schema.items);
        if (err) return err;
      }
    }
  }
  return null;
}

/**
 * Validates parsed tool arguments against the tool's object schema.
 * Returns null when valid, or the first precise error message.
 */
export function validateAgainstSchema(
  schema: ArgSchema | undefined,
  args: Record<string, unknown>
): string | null {
  if (!schema) return null;
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) {
      return `Missing required argument: "${key}".`;
    }
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) continue;
    const err = validateValue(key, args[key], sub);
    if (err) return err;
  }
  return null;
}

// ── The registry ─────────────────────────────────────────────

/** How a tool executes (routes inside chat-runner) */
export type ToolKind =
  /** Read-only GitHub-API tools; cacheable, runnable inside run_tool_program */
  | "read"
  /** Workspace/gate/preview tools routed through the agent bridge; never cached */
  | "bridge"
  /** The program interpreter itself (meta tool) */
  | "program";

export interface AgentToolMeta {
  name: ToolName;
  /** Model-facing description (goes into the wire definition) */
  description: string;
  /** JSON-Schema for the arguments object (validated + sent on the wire) */
  parameters: ArgSchema;
  kind: ToolKind;
  /** Read results may live in the session LRU (tool-cache.ts) */
  cacheable: boolean;
  /** Allowed as a step inside run_tool_program programs */
  programmable: boolean;
  /** Activity-row summary line for the transcript UI */
  summarize: (args: Record<string, unknown>, ok: boolean) => string;
}

// Reusable schema fragments
const SUBTREE_PARAM: ArgSchema = {
  type: "string",
  description:
    "Optional directory prefix to narrow the listing (e.g. 'src/features'). Omit for the whole repo.",
};

const REPO_PATH_PARAM: ArgSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "Full path from the repo root (e.g. 'src/App.tsx'). Required.",
};

/**
 * Every agent tool in one table. Order is the wire order (models
 * attend slightly to schema order — discovery tools first).
 */
export const TOOL_REGISTRY: readonly AgentToolMeta[] = [
  {
    name: "list_repo_files",
    description:
      "List files and directories in the attached GitHub repository. Returns a tree of paths; use this first to discover the project structure, then read specific files.",
    parameters: { type: "object", properties: { subtree: SUBTREE_PARAM } },
    kind: "read",
    cacheable: true,
    programmable: true,
    summarize: (args) =>
      typeof args.subtree === "string" && args.subtree ? args.subtree + "/" : "full tree",
  },
  {
    name: "read_file",
    description:
      "Read the full text content of one file from the repository. Prefer reading only files relevant to the question. Very large files are tail-truncated.",
    parameters: {
      type: "object",
      properties: { path: REPO_PATH_PARAM },
      required: ["path"],
    },
    kind: "read",
    cacheable: true,
    programmable: true,
    summarize: (args) => (typeof args.path === "string" ? args.path : "(unknown path)"),
  },
  {
    name: "search_code",
    description:
      "Full-text code search inside the repository (GitHub code search). Returns matching file paths with fragments. Use for finding symbols, strings, or usages without knowing the file.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "GitHub code search query text (e.g. a function name). Scoped automatically to the attached repo.",
        },
      },
      required: ["query"],
    },
    // search results are time-sensitive (indexing) — never cached
    kind: "read",
    cacheable: false,
    programmable: true,
    summarize: (args) => (typeof args.query === "string" ? `"${args.query}"` : "(no query)"),
  },
  {
    name: "get_repo_overview",
    description:
      "Get a summary of the repository: top-level structure, the README's opening section, and the largest/dominant directories. Useful as the very first call when exploring an unknown repo.",
    parameters: { type: "object", properties: {} },
    kind: "read",
    cacheable: true,
    programmable: true,
    summarize: (_args, ok) => (ok ? "repository overview" : "overview failed"),
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the local agent workspace (NOT on GitHub). Reads the current version from the repo automatically if needed. Always read_file before substantially rewriting an existing file. Changes become visible in the live preview and are pushed only via push_changes after user approval.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Repo-relative path (e.g. 'src/App.tsx'). Required.",
        },
        content: {
          type: "string",
          maxLength: 1_500_000,
          description: "The complete new file content. This replaces the whole file.",
        },
      },
      required: ["path", "content"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.path === "string" ? args.path : "(unknown path)"),
  },
  {
    name: "delete_file",
    description:
      "Delete a file in the local agent workspace (NOT on GitHub). The deletion lands on GitHub only via push_changes.",
    parameters: {
      type: "object",
      properties: { path: { ...REPO_PATH_PARAM, description: "Repo-relative path of the file to delete. Required." } },
      required: ["path"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.path === "string" ? args.path : "(unknown path)"),
  },
  {
    name: "create_working_branch",
    description:
      "Create a remote agent working branch (agent/...) from the attached branch. Optional — push_changes creates one automatically when needed. Use it to name the branch yourself before pushing.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          maxLength: 64,
          description:
            "Optional short branch slug (e.g. 'fix-login-bug'). A timestamped agent/ prefix is added automatically.",
        },
      },
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.name === "string" && args.name ? args.name : "working branch"),
  },
  {
    name: "push_changes",
    description:
      "Ship all workspace changes to GitHub as ONE commit on the agent working branch and (by default) open a pull request. The user must approve the diff in a review dialog first — this call pauses until they decide. If the user rejects, their note arrives in the result; refine the changes and call push_changes again.",
    parameters: {
      type: "object",
      properties: {
        commitMessage: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description:
            "Conventional commit message for the squashed change set (e.g. 'feat(auth): add password reset flow'). Required.",
        },
        prTitle: { type: "string", maxLength: 200, description: "Pull request title. Defaults to the commit message." },
        prBody: {
          type: "string",
          maxLength: 8_000,
          description: "Pull request body in Markdown: what changed and why. Recommended.",
        },
      },
      required: ["commitMessage"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.commitMessage === "string" ? args.commitMessage.slice(0, 60) : "push to GitHub",
  },
  {
    name: "get_preview_feedback",
    description:
      "Fetch build errors and runtime console output from the live preview of the workspace. Call after writing files to verify your changes compile and run; fix the reported issues and check again.",
    parameters: {
      type: "object",
      properties: {
        screenshot: {
          type: "boolean",
          description: "Set true to note that a visual check of the preview pane is recommended.",
        },
      },
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: () => "preview check",
  },
  {
    name: "run_in_preview",
    description:
      "Execute a JavaScript expression or snippet INSIDE the live preview iframe (the built workspace app) and return the JSON-serialized result. Use it to verify behavior after edits: read runtime state, call exported functions, or compute assertions (throw on failure to report a failed check). Runs against the CURRENT build — write files first, then call this.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          minLength: 1,
          maxLength: 8_000,
          description:
            "JavaScript to evaluate in the preview page (async/await allowed; the final expression's value is returned). Throw an Error to report a failed assertion.",
        },
      },
      required: ["code"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: () => "run in preview",
  },
  {
    name: "query_preview_dom",
    description:
      "Query the live preview's rendered DOM with a CSS selector. Returns the match count plus outerHTML/text snippets (size-capped). Use it to verify that UI changes actually rendered: check elements, text content, classes, or computed structure after edits.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "CSS selector, e.g. '.cart-total' or '#root button.primary'.",
        },
        mode: {
          type: "string",
          enum: ["html", "text"],
          description: "Snippet flavor: 'html' (outerHTML) or 'text' (text content). Defaults to 'html'.",
        },
      },
      required: ["selector"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.selector === "string" ? args.selector : "(no selector)"),
  },
  {
    name: "run_tool_program",
    description:
      "Batch up to 8 of the read-only calls above into ONE call (e.g. read three files, or search then read the hits). One program = one transcript round trip instead of one per tool call — much faster and cheaper. Later steps can reference earlier results via $variable.path strings.",
    parameters: {
      type: "object",
      properties: {
        program: {
          type: "array",
          maxItems: 8,
          description:
            'Steps: {"read":"name","tool":"read_file","args":{"path":"src/a.ts"}} — tool must be a read-only tool; string args may reference $name or $name.path.',
          items: {
            type: "object",
            properties: {
              read: { type: "string", description: "Variable name to bind the result to (optional)." },
              tool: { type: "string", description: "One of the read-only tools." },
              args: { type: "object", description: "Tool arguments; strings may use $refs." },
            },
            required: ["tool"],
          },
        },
      },
      required: ["program"],
    },
    kind: "program",
    cacheable: false,
    programmable: false,
    summarize: () => "tool program",
  },
];

// ── Derived lookups (the old scattered sets, unified) ─────────

const BY_NAME = new Map<string, AgentToolMeta>(TOOL_REGISTRY.map((t) => [t.name, t]));

/** Wire definitions sent with agent-mode requests (schema order preserved) */
export const AGENT_TOOLS: ToolDefinition[] = TOOL_REGISTRY.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  },
}));

export function getToolMeta(name: ToolName): AgentToolMeta | undefined {
  return BY_NAME.get(name);
}

export function isValidToolName(name: string): name is ToolName {
  return BY_NAME.has(name);
}

export function isAgentBridgeTool(name: ToolName): boolean {
  return BY_NAME.get(name)?.kind === "bridge";
}

export function isToolCacheable(name: ToolName): boolean {
  return BY_NAME.get(name)?.cacheable === true;
}

export function isProgrammableTool(name: ToolName): boolean {
  return BY_NAME.get(name)?.programmable === true;
}

/** Names allowed as run_tool_program steps (single source of truth) */
export const PROGRAMMABLE_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.filter((t) => t.programmable).map((t) => t.name)
);

/**
 * Explicit context passed to tool executors (declared here because
 * read tools and bridge tools share the same shape).
 */
export interface ToolExecutionContext {
  token: string;
  repo: RepoContext;
  signal?: AbortSignal;
  /** Owning conversation id — enables workspace-aware reads */
  conversationId?: string;
}

/** Activity-row summary for any tool (used by executors) */
export function summarizeToolCall(
  name: ToolName,
  args: Record<string, unknown>,
  ok: boolean
): string {
  const meta = BY_NAME.get(name);
  if (!meta) return "";
  try {
    return meta.summarize(args, ok);
  } catch {
    return "";
  }
}

/** Parsed-and-validated tool arguments, or a precise error message */
export type ToolCallValidation = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * Validates one model-emitted tool call BEFORE execution: unknown
 * names and malformed arguments fail fast with a precise message
 * that goes back to the model as a tool result, so it can
 * self-correct in the next iteration instead of hitting a vague
 * executor error.
 */
export function validateToolCall(name: string, rawArguments: string): ToolCallValidation {
  const meta = BY_NAME.get(name);
  if (!meta) {
    const known = TOOL_REGISTRY.map((t) => t.name).join(", ");
    return { ok: false, error: `Unknown tool: "${name}". Available tools: ${known}.` };
  }
  let args: Record<string, unknown> = {};
  if (rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        return { ok: false, error: `Tool arguments for "${name}" must be a JSON object.` };
      }
    } catch {
      return {
        ok: false,
        error: `Tool arguments for "${name}" are not valid JSON. Re-emit the call with a valid JSON arguments object.`,
      };
    }
  }
  const schemaErr = validateAgainstSchema(meta.parameters, args);
  if (schemaErr) return { ok: false, error: schemaErr };
  return { ok: true, args };
}
