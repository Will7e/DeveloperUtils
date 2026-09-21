// ============================================================
// Agent Tools — GitHub Tool Definitions & Executor
// ============================================================
// The executor that maps a parsed tool call to the GitHub client.
// Tool schemas, kinds, cacheability, and summarizers live in the
// declarative registry (lib/tool-registry.ts); this module only
// executes. Every call is validated through the registry BEFORE
// execution so malformed model calls fail fast with a precise,
// self-correcting error. Tool results are size-capped so one
// careless read can't consume the whole context budget — the
// existing compaction engine covers the rest. UI-free and
// store-free (deps passed in explicitly).

import {
  GITHUB_MAX_FILE_BYTES,
  GITHUB_MAX_TREE_ENTRIES,
  TOOL_PROGRAM_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
} from "../constants";
import {
  getRepoTree,
  readFileContent,
  searchCodeInRepo,
  GitHubError,
  type GitHubTreeEntry,
} from "./github-client";
import type { RepoContext, ToolCallRequest, ToolCallResult } from "../types";
import { runToolProgram } from "./tool-program";
import { AGENT_TOOLS, summarizeToolCall } from "./tool-registry";

// Schemas + tool metadata (including the single source of truth for
// tool names, kinds, and summarizers) live in lib/tool-registry.ts.
// AGENT_TOOLS is re-exported for existing importers.
export { AGENT_TOOLS, summarizeToolCall };

/** Registry-backed summary line for the activity UI */
const summarize = summarizeToolCall;

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
  /** Owning conversation id — enables workspace-aware reads */
  conversationId?: string;
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

        // Workspace-first: the agent must see its own edits, and
        // tombstoned files should read as deleted rather than resurrect
        // pristine repo content.
        try {
          const { useChatStore } = await import("@/stores/chat.store");
          const ws = useChatStore.getState().workspaces[ctx.conversationId ?? ""];
          const local = ws?.files[path];
          if (local) {
            if (local.status === "deleted") {
              return {
                callId: call.id,
                name: call.name,
                ok: true,
                data: { path, note: "File is deleted in the agent workspace (pending push)." },
                durationMs: Date.now() - started,
                summary: path,
              };
            }
            return {
              callId: call.id,
              name: call.name,
              ok: true,
              data: { path, content: local.content, source: "workspace" },
              durationMs: Date.now() - started,
              summary: path,
            };
          }
        } catch {
          /* store unavailable — fall through to GitHub */
        }

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

      case "run_tool_program": {
        // Programmatic tool calling: one wire call → up to 8 read-only
        // steps, executed sequentially with per-step session-cache reuse.
        // The injected executor re-enters this switch, but only with
        // whitelisted read-only tools (enforced by the interpreter), so
        // recursion depth is exactly 1 and writes can never run.
        return runToolProgram({
          call,
          repo,
          token,
          signal,
          execute: (stepCall) => executeToolCall(stepCall, ctx),
        });
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
  // Program results already carry a shaped `output` (which embeds the
  // per-step log) — send it as the payload; metadata would only add bulk.
  if (result.name === "run_tool_program" && typeof (payload as { output?: unknown }).output === "string") {
    return truncateForBudget(
      (payload as { output: string }).output,
      Math.max(TOOL_RESULT_MAX_CHARS, TOOL_PROGRAM_MAX_CHARS)
    );
  }
  return truncateForBudget(JSON.stringify(payload));
}
