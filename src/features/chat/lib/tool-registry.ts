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

import type { ChatMode, RepoContext, ToolDefinition, ToolName } from "../types";

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
  /**
   * Allowed in Plan mode: the tool cannot change the workspace, the
   * preview bundle, or GitHub. Mutating tools (write/edit/delete, the
   * branch + push gate) are withheld from the request AND refused by
   * the executor, so a plan-mode turn cannot ship code even if the
   * model emits a call for a tool it never received.
   */
  planSafe: boolean;
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
    planSafe: true,
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
    planSafe: true,
    description:
      "Read the text content of one file. Returns the working copy from the agent workspace when the file has been edited. Prefer reading only files relevant to the question. Very large files are tail-truncated — use startLine/endLine to read a window of one instead of rewriting it wholesale.",
    parameters: {
      type: "object",
      properties: {
        path: REPO_PATH_PARAM,
        startLine: {
          type: "number",
          description: "Optional 1-based first line to return (windows a large file).",
        },
        endLine: {
          type: "number",
          description: "Optional 1-based last line to return, inclusive.",
        },
      },
      required: ["path"],
    },
    kind: "read",
    cacheable: true,
    programmable: true,
    summarize: (args) => {
      const path = typeof args.path === "string" ? args.path : "(unknown path)";
      const from = typeof args.startLine === "number" ? args.startLine : undefined;
      const to = typeof args.endLine === "number" ? args.endLine : undefined;
      return from !== undefined || to !== undefined
        ? `${path}:${from ?? 1}-${to ?? "end"}`
        : path;
    },
  },
  {
    name: "search_workspace",
    planSafe: true,
    description:
      "Search the agent's working copy with a plain substring or regex — the local counterpart to search_code. It sees files the agent has edited (which GitHub search cannot), works on any branch, and is not rate-limited. Cheaper and more up-to-date than search_code for questions about code you just wrote; use search_code to explore the untouched repository.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Text to find. Case-insensitive; treated as a regex when mode is 'regex'.",
        },
        pathPrefix: {
          type: "string",
          maxLength: 256,
          description: "Optional directory prefix to search within (e.g. 'src/features').",
        },
        mode: {
          type: "string",
          enum: ["text", "regex"],
          description: "Match mode: 'text' (default) or 'regex' (JavaScript syntax).",
        },
        maxResults: {
          type: "number",
          description: "Maximum matches to return, 1-50 (default 20).",
        },
      },
      required: ["query"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.query === "string" ? `"${args.query}"` : "(no query)"),
  },
  {
    name: "search_code",
    planSafe: true,
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
    planSafe: true,
    description:
      "Get a summary of the repository: top-level structure, the README's opening section, and the largest/dominant directories. Useful as the very first call when exploring an unknown repo.",
    parameters: { type: "object", properties: {} },
    kind: "read",
    cacheable: true,
    programmable: true,
    summarize: (_args, ok) => (ok ? "repository overview" : "overview failed"),
  },
  {
    name: "read_skill",
    planSafe: true,
    description:
      "Load the full instructions of one available skill by name (see the Available Skills index in your instructions). Skills are loaded on demand rather than shipped in every prompt, so call this before starting work a skill's triggers match — it is cheap and makes the rest of the turn more accurate.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Skill name or id exactly as listed in the Available Skills index.",
        },
        query: {
          type: "string",
          maxLength: 200,
          description:
            "Optional: omit `name` and describe the task instead to see which skills apply.",
        },
      },
    },
    kind: "read",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.name === "string" && args.name
        ? args.name
        : typeof args.query === "string"
          ? `"${args.query.slice(0, 40)}"`
          : "skill index",
  },
  {
    name: "delegate",
    planSafe: true,
    description:
      "Hand a RESEARCH task to a helper agent that runs in its own context and returns only a report. Use it to explore a large area (find how X works, locate every usage of Y, map a subsystem) when the searching itself would flood your context with file contents you do not need. The helper is read-only — it can read and search but NEVER edit, push, or run anything. Say exactly what you want back. Anything the helper finds must still be verified by you before you act on it.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 2_000,
          description:
            "What to find out, stated as a question with a concrete deliverable (files, symbols, line ranges).",
        },
        maxIterations: {
          type: "number",
          description: "Helper tool-call rounds, 1-8 (default 4).",
        },
      },
      required: ["task"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.task === "string" ? args.task.slice(0, 60) : "research task",
  },
  {
    name: "write_file",
    planSafe: false,
    description:
      "Create a new file, or overwrite one you have read in its entirety, in the local agent workspace (NOT on GitHub). Content must be the COMPLETE file text — anything omitted is deleted. To change part of an existing file, use edit_file instead: it is safer and far cheaper. Changes are visible in the live preview and reach GitHub only via push_changes after user approval.",
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
    name: "edit_file",
    planSafe: false,
    description:
      "Edit one region of an existing workspace file by exact string replacement — the preferred way to change code you have read, because it never touches the rest of the file. oldString must match the file byte-for-byte (including indentation) and must be unique unless replaceAll is true; a failed match returns the closest candidates. Use write_file only for new files or full rewrites.",
    parameters: {
      type: "object",
      properties: {
        path: REPO_PATH_PARAM,
        oldString: {
          type: "string",
          minLength: 1,
          maxLength: 200_000,
          description: "Exact existing text to replace (include surrounding lines for uniqueness).",
        },
        newString: {
          type: "string",
          maxLength: 200_000,
          description: "Replacement text. Use an empty string to delete the matched region.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring a unique match.",
        },
      },
      required: ["path", "oldString", "newString"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) => (typeof args.path === "string" ? args.path : "(unknown path)"),
  },
  {
    name: "delete_file",
    planSafe: false,
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
    name: "remember",
    planSafe: false,
    description:
      "Record a durable fact about THIS repository into .intab/memory.md in the workspace, so later conversations start from what you already learned instead of rediscovering it. Use it for stable, project-specific knowledge: build/test commands, environment and tooling quirks, conventions, architectural decisions, gotchas. Do NOT use it for task progress, user preferences, or secrets. Written memories reach GitHub only through push_changes (so the user reviews them like any other change), and a memory you record should be one line of fact, not a narrative.",
    parameters: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description:
            "One sentence of durable, repo-specific fact (e.g. 'Tests run with `npm test` (vitest); there is no shell here, so the user must run them.').",
        },
      },
      required: ["fact"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.fact === "string" ? args.fact.slice(0, 60) : "project memory",
  },
  {
    name: "list_mcp_tools",
    planSafe: true,
    description:
      "List the tools exposed by the user's connected MCP servers (external services like issue trackers, docs, or databases). Call this BEFORE call_mcp_tool when you are unsure what is available, or when a task mentions a service that is not in this repository. Servers the browser cannot reach (CORS) are reported with that reason rather than silently missing.",
    parameters: { type: "object", properties: {} },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: () => "MCP tools",
  },
  {
    name: "call_mcp_tool",
    planSafe: false,
    description:
      "Call one tool on one connected MCP server. Arguments must match the tool's input schema (see list_mcp_tools). These tools act OUTSIDE this repository and can create or change real data in an external service, so only call one when the user's request clearly needs it, and report what you changed. Results are text only.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Server id or name exactly as reported by list_mcp_tools.",
        },
        tool: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Tool name as the server exposes it.",
        },
        arguments: {
          type: "object",
          description: "Arguments object for the tool (may be empty).",
        },
      },
      required: ["server", "tool"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.tool === "string"
        ? `${typeof args.server === "string" ? `${args.server}/` : ""}${args.tool}`
        : "MCP call",
  },
  {
    name: "get_workspace_diff",
    planSafe: true,
    description:
      "Read the diff of everything changed in the workspace since the base commit (optionally one file). Use it to review your own change set before pushing — after compaction this is the only reliable record of what you have edited.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          maxLength: 512,
          description: "Optional single file to diff instead of the whole change set.",
        },
        maxPatchChars: {
          type: "number",
          description: "Per-file patch budget in characters (default 4000, max 12000).",
        },
      },
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.path === "string" && args.path ? args.path : "all changes",
  },
  {
    name: "create_working_branch",
    planSafe: false,
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
    planSafe: false,
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
    planSafe: true,
    description:
      "Fetch build errors and runtime console output from the live preview of the workspace. Call after writing files to verify your changes compile and run; fix the reported issues and check again.",
    parameters: { type: "object", properties: {} },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: () => "preview check",
  },
  {
    name: "run_in_preview",
    planSafe: true,
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
    planSafe: true,
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
    name: "run_checks",
    planSafe: true,
    description:
      "Report what this repository declares must be verified (test / lint / typecheck / build scripts, or an .intab/verify.json manifest) and what of it could actually be executed. There is no shell in this workspace, so by default NOTHING runs: the result names each declared check, the exact command, and states plainly that none ran. Use it before you summarise a change set, so your report names the checks you did not run instead of implying they passed. When the user has configured a checks runner, the declared commands are executed there and real results come back.",
    parameters: {
      type: "object",
      properties: {
        run: {
          type: "boolean",
          description:
            "Set true to also execute the declared checks on the configured runner (no-op with an explanation when none is configured). Default false = report only.",
        },
      },
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args, ok) =>
      args.run === true ? (ok ? "checks executed" : "check run failed") : "declared checks",
  },
  {
    name: "get_preview_layout",
    planSafe: true,
    description:
      "Read a compact LAYOUT MAP of the running preview: viewport and document size, plus each visible element's box, whether it overflows or is clipped, and its text. Use it to verify visual results that query_preview_dom cannot see — collapsed containers, content spilling off-screen, elements stacked on top of each other, zero-height sections. Call it after a UI change and fix what it reports.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          maxLength: 300,
          description: "Optional CSS selector to scope the map to one subtree (default: whole document).",
        },
        maxElements: {
          type: "number",
          description: "Maximum elements to report, 1-80 (default 40, largest-first).",
        },
      },
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (args) =>
      typeof args.selector === "string" && args.selector ? args.selector : "layout map",
  },
  {
    name: "check_preview_visually",
    planSafe: true,
    description:
      "Look at the running preview and answer a question about how it RENDERS. A screenshot is captured inside the preview frame and analysed by a vision model; you get back its written verdict (VERDICT: ok | problem | unclear, plus specific issues). Use it for what DOM queries and geometry cannot see: wrong or missing colours, text that is invisible against its background, broken images, an element that collapsed to nothing, a dialog painted behind an overlay, a layout that clearly is not what the user asked for. It sees PIXELS ONLY — it cannot read or judge code — and the capture is approximate (web fonts and remote images may be missing, so a font or image substitution is not a defect). It costs one extra request on a vision-capable model.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          maxLength: 500,
          description:
            'What the picture should show, phrased so a defect is visible — e.g. "Is the total price visible and readable against the card background?"',
        },
        claim: {
          type: "string",
          maxLength: 500,
          description:
            "Optional: what you believe the change did, so the check can confirm or refute it instead of describing the whole page.",
        },
        selector: {
          type: "string",
          maxLength: 300,
          description:
            "Optional CSS selector to capture one element instead of the whole viewport (use it when you only need to check a specific component).",
        },
      },
      required: ["question"],
    },
    kind: "bridge",
    cacheable: false,
    programmable: false,
    summarize: (_args, ok) => (ok ? "visual check" : "visual check unavailable"),
  },
  {
    name: "run_tool_program",
    planSafe: true,
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

/** True when a tool may run in Plan mode (never mutates anything) */
export function isPlanSafeTool(name: ToolName): boolean {
  return BY_NAME.get(name)?.planSafe === true;
}

/** Wire definitions allowed in Plan mode (the read-only subset) */
export const PLAN_MODE_TOOLS: ToolDefinition[] = TOOL_REGISTRY.filter(
  (t) => t.planSafe
).map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as Record<string, unknown>,
  },
}));

/** Tool definitions to send for an agent mode */
export function toolsForMode(mode: ChatMode): ToolDefinition[] {
  return mode === "plan" ? PLAN_MODE_TOOLS : AGENT_TOOLS;
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
