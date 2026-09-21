// ============================================================
// Agent Tools — GitHub Tool Definitions & Executor
// ============================================================
// OpenAI-style tool schemas the model calls in agent mode, plus the
// executor that maps a parsed tool call to the GitHub client. Tool
// results are size-capped so one careless read can't consume the
// whole context budget — the existing compaction engine covers the
// rest. UI-free and store-free (deps passed in explicitly).

import {
  GITHUB_MAX_FILE_BYTES,
  GITHUB_MAX_TREE_ENTRIES,
  TOOL_RESULT_MAX_CHARS,
} from "../constants";
import {
  getRepoTree,
  readFileContent,
  searchCodeInRepo,
  GitHubError,
  type GitHubTreeEntry,
} from "./github-client";
import type { RepoContext, ToolCallRequest, ToolCallResult, ToolDefinition, ToolName } from "../types";

// ── Schemas ──────────────────────────────────────────────────

const SUBTREE_PARAM = {
  type: "string",
  description:
    "Optional directory prefix to narrow the listing (e.g. 'src/features'). Omit for the whole repo.",
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_repo_files",
      description:
        "List files and directories in the attached GitHub repository. Returns a tree of paths; use this first to discover the project structure, then read specific files.",
      parameters: {
        type: "object",
        properties: {
          subtree: SUBTREE_PARAM,
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full text content of one file from the repository. Prefer reading only files relevant to the question. Very large files are tail-truncated.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Full path from the repo root (e.g. 'src/App.tsx'). Required.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description:
        "Full-text code search inside the repository (GitHub code search). Returns matching file paths with fragments. Use for finding symbols, strings, or usages without knowing the file.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "GitHub code search query text (e.g. a function name). Scoped automatically to the attached repo.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_repo_overview",
      description:
        "Get a summary of the repository: top-level structure, the README's opening section, and the largest/dominant directories. Useful as the very first call when exploring an unknown repo.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/** Names of valid tools — validation for model-emitted calls */
const VALID_TOOL_NAMES = new Set<ToolName>([
  "list_repo_files",
  "read_file",
  "search_code",
  "get_repo_overview",
]);

export function isValidToolName(name: string): name is ToolName {
  return VALID_TOOL_NAMES.has(name as ToolName);
}

// ── Formatting helpers (model-facing result shaping) ─────────

function truncateForBudget(text: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/** Groups tree entries into a compact, model-readable listing */
function formatTreeListing(
  entries: GitHubTreeEntry[],
  subtree?: string,
  maxEntries = 400
): string {
  const prefix = subtree ? subtree.replace(/\/+$/, "") + "/" : "";
  const scoped = prefix
    ? entries.filter((e) => e.path.startsWith(prefix) && e.path !== prefix.slice(0, -1))
    : entries;

  if (scoped.length === 0) {
    return `No entries found${prefix ? ` under '${prefix}'` : ""}.`;
  }

  const files = scoped.filter((e) => e.type === "blob");
  const dirs = new Set(scoped.filter((e) => e.type === "tree").map((e) => e.path));

  const lines: string[] = [];
  let count = 0;
  let omitted = 0;

  for (const entry of files) {
    if (count >= maxEntries) {
      omitted = files.length - count;
      break;
    }
    lines.push(entry.path);
    count++;
  }

  const dirNote = dirs.size > 0 ? `\n(${dirs.size} directories — list with subtree="dir" to expand)` : "";
  const omittedNote = omitted > 0 ? `\n…and ${omitted} more files (narrow with subtree=)` : "";

  const truncatedByApi = entries.length >= GITHUB_MAX_TREE_ENTRIES;
  const apiNote = truncatedByApi
    ? "\n[Note: the repository tree is very large; this listing may be incomplete.]"
    : "";

  return `Repository files${prefix ? ` under '${prefix}'` : " (root)"} — ${files.length} files:\n${lines.join("\n")}${dirNote}${omittedNote}${apiNote}`;
}

/** Extracts the README's opening markdown for the overview tool */
function readmeExcerpt(text: string, maxChars = 1_800): string {
  const trimmed = text.trim();
  if (!trimmed) return "(empty README)";
  // Skip front-matter/badges noise: cut at the first heading or paragraph
  const excerpt = trimmed.slice(0, maxChars);
  return excerpt + (trimmed.length > maxChars ? "\n…[excerpt]" : "");
}

// ── Executor ─────────────────────────────────────────────────

export interface ToolExecutionContext {
  token: string;
  repo: RepoContext;
  signal?: AbortSignal;
}

/** Human-readable summary line for the activity UI */
function summarize(name: ToolName, args: Record<string, unknown>, ok: boolean): string {
  switch (name) {
    case "list_repo_files":
      return typeof args.subtree === "string" && args.subtree ? args.subtree + "/" : "full tree";
    case "read_file":
      return typeof args.path === "string" ? args.path : "(unknown path)";
    case "search_code":
      return typeof args.query === "string" ? `"${args.query}"` : "(no query)";
    case "get_repo_overview":
      return ok ? "repository overview" : "overview failed";
    default:
      return "";
  }
}

/** Parses the model's raw arguments JSON defensively */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Executes one tool call against the GitHub API. Never throws —
 * failures are returned as `{ ok: false, error }` results so the
 * model can see them and adapt.
 */
export async function executeToolCall(
  call: ToolCallRequest,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  const started = Date.now();
  const args = parseToolArguments(call.arguments);
  const { token, repo, signal } = ctx;
  const fail = (error: string): ToolCallResult => ({
    callId: call.id,
    name: call.name,
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: summarize(call.name, args, false),
  });

  if (signal?.aborted) return fail("Aborted by the user.");

  try {
    switch (call.name) {
      case "list_repo_files": {
        const tree = await getRepoTree(token, repo.owner, repo.repo, repo.branch);
        if (signal?.aborted) return fail("Aborted by the user.");
        const listing = formatTreeListing(tree, typeof args.subtree === "string" ? args.subtree : undefined);
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: { listing },
          durationMs: Date.now() - started,
          summary: summarize(call.name, args, true),
        };
      }

      case "read_file": {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return fail("Missing required argument: path");
        const file = await readFileContent(token, repo.owner, repo.repo, path, repo.branch);
        if (signal?.aborted) return fail("Aborted by the user.");
        if (file.isBinary) {
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { path, note: "Binary file — text content not available.", size: file.size },
            durationMs: Date.now() - started,
            summary: path,
          };
        }
        if (file.text === null) {
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: {
              path,
              note: `File is ${Math.round(file.size / 1024)} KB — too large to read via the Contents API.`,
            },
            durationMs: Date.now() - started,
            summary: path,
          };
        }

        let text = file.text;
        let truncatedNote: string | undefined;
        if (text.length > GITHUB_MAX_FILE_BYTES) {
          const omitted = text.length - GITHUB_MAX_FILE_BYTES;
          text = `${text.slice(0, GITHUB_MAX_FILE_BYTES)}\n…[tail truncated — ${omitted} chars omitted; read a narrower file if needed]`;
          truncatedNote = "tail-truncated";
        }

        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: { path, truncated: truncatedNote, content: text },
          durationMs: Date.now() - started,
          summary: path,
        };
      }

      case "search_code": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return fail("Missing required argument: query");
        const results = await searchCodeInRepo(token, repo.owner, repo.repo, query);
        if (signal?.aborted) return fail("Aborted by the user.");
        if (results.length === 0) {
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { query, results: [], note: "No matches (code search only indexes the default branch)." },
            durationMs: Date.now() - started,
            summary: `"${query}"`,
          };
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            query,
            results: results.map((r) => ({ path: r.path, fragment: r.fragment })),
          },
          durationMs: Date.now() - started,
          summary: `"${query}"`,
        };
      }

      case "get_repo_overview": {
        const tree = await getRepoTree(token, repo.owner, repo.repo, repo.branch);
        if (signal?.aborted) return fail("Aborted by the user.");

        const rootEntries = tree
          .filter((e) => !e.path.includes("/"))
          .map((e) => (e.type === "tree" ? `${e.path}/` : e.path));
        const readmeEntry = tree.find(
          (e) => e.type === "blob" && /^readme\.md$/i.test(e.path)
        );

        let readme = "";
        if (readmeEntry) {
          try {
            const file = await readFileContent(token, repo.owner, repo.repo, readmeEntry.path, repo.branch);
            if (file.text) readme = `\n\nREADME (excerpt):\n${readmeExcerpt(file.text)}`;
          } catch {
            /* README is best-effort */
          }
        }

        const listing = formatTreeListing(tree, undefined, 150);
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            repo: `${repo.owner}/${repo.repo}`,
            branch: repo.branch,
            rootEntries: truncateForBudget(rootEntries.join("\n"), 2_500),
            listing,
            readme: readme || undefined,
          },
          durationMs: Date.now() - started,
          summary: "repository overview",
        };
      }

      default:
        return fail(`Unknown tool: ${String(call.name)}`);
    }
  } catch (err) {
    if (err instanceof GitHubError) {
      return fail(err.message);
    }
    return fail(
      err instanceof Error ? err.message : "Tool execution failed unexpectedly."
    );
  }
}

/** Serializes a ToolCallResult into the wire-format content string */
export function serializeToolResult(result: ToolCallResult): string {
  const payload = result.ok ? result.data : { error: result.data };
  return truncateForBudget(JSON.stringify(payload));
}
