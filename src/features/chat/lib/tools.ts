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
import { readViewFor } from "./tool-cache";
import { findSkill, matchSkills } from "./skills";
import { isUntrustedTool, wrapUntrusted } from "./untrusted";
import { AGENT_TOOLS, summarizeToolCall } from "./tool-registry";
import type { ChatSkill } from "../types";
import { WEB_MAX_TEXT_CHARS, flattenWebBody } from "./web-page";
import { fetchWebDocument } from "./web-fetch";
import { searchWeb } from "./search-client";
import { SEARCH_DEFAULT_LIMIT } from "./search-providers";
import { isWithinSubtree, matchesGlob } from "./path-glob";

/** Files one `read_files` call may ask for (schema maxItems must agree) */
const MAX_READ_FILES = 12;
/** Paths `find_files` returns when the caller does not say */
const FIND_FILES_DEFAULT_RESULTS = 60;
/** Ceiling for `find_files` (the schema's maxResults must agree) */
const FIND_FILES_MAX_RESULTS = 200;

/**
 * Reads the installed skills (builtins + user) from the chat store.
 * Imported lazily so this module stays usable in tests and workers
 * where no store exists.
 */
async function loadSkills(): Promise<ChatSkill[]> {
  try {
    const { useChatStore } = await import("@/stores/chat.store");
    return useChatStore.getState().settings.skills ?? [];
  } catch {
    return [];
  }
}

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

/**
 * Paths from a tree that match a glob, optionally scoped to a subtree.
 *
 * Pure and exported so the matching rules are tested directly: a filename
 * search whose rules are only observable through a network-backed tool is a
 * search nobody will fix when it is subtly wrong. Ordering is by path depth
 * then name, which puts the shallow, most-likely-intended hits first.
 */
export function findMatchingPaths(
  entries: readonly { path: string; type: string }[],
  pattern: string,
  subtree?: string
): string[] {
  const scope = subtree?.trim() ?? "";
  return entries
    .filter((e) => e.type === "blob")
    .map((e) => e.path)
    .filter((path) => (scope ? isWithinSubtree(path, scope) : true))
    .filter((path) => matchesGlob(path, pattern))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/**
 * Applies an optional 1-based, inclusive line window to file text.
 * Windows are how the agent reads (and therefore safely edits) files
 * that are larger than the per-read budget.
 */
function windowLines(
  text: string,
  startLine?: number,
  endLine?: number
): { text: string; startLine: number; endLine: number; totalLines: number; windowed: boolean } {
  const totalLines = text === "" ? 0 : text.split("\n").length;
  if (startLine === undefined && endLine === undefined) {
    return { text, startLine: 1, endLine: totalLines, totalLines, windowed: false };
  }
  const lines = text.split("\n");
  const from = Math.min(Math.max(1, startLine ?? 1), Math.max(1, lines.length));
  const to = Math.min(Math.max(from, endLine ?? lines.length), lines.length);
  return {
    text: lines.slice(from - 1, to).join("\n"),
    startLine: from,
    endLine: to,
    totalLines,
    windowed: true,
  };
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
        const startLine =
          typeof args.startLine === "number" && Number.isFinite(args.startLine)
            ? Math.floor(args.startLine)
            : undefined;
        const endLine =
          typeof args.endLine === "number" && Number.isFinite(args.endLine)
            ? Math.floor(args.endLine)
            : undefined;

        // Workspace-first: the agent must see its own edits, and
        // tombstoned files should read as deleted rather than resurrect
        // pristine repo content.
        try {
          const { selectWorkspace, useChatStore } = await import("@/stores/chat.store");
          // Fail closed: another repository's working copy is not this agent's
          // view of the file, so a miss falls through to the repository the
          // thread is actually on.
          const ws = selectWorkspace(useChatStore.getState(), ctx.conversationId ?? "");
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
            const win = windowLines(local.content, startLine, endLine);
            return {
              callId: call.id,
              name: call.name,
              ok: true,
              data: {
                path,
                content: win.text,
                source: "workspace",
                ...(win.windowed
                  ? {
                      startLine: win.startLine,
                      endLine: win.endLine,
                      totalLines: win.totalLines,
                    }
                  : {}),
              },
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

        const win = windowLines(file.text, startLine, endLine);
        let text = win.text;
        let truncatedNote: string | undefined;
        if (text.length > GITHUB_MAX_FILE_BYTES) {
          const omitted = text.length - GITHUB_MAX_FILE_BYTES;
          // Never let a truncated read look complete: rewriting a file
          // from a truncated view destroys its tail, so point the model
          // at the windowed + targeted-edit path instead.
          text = `${text.slice(0, GITHUB_MAX_FILE_BYTES)}\n…[tail truncated — ${omitted} chars omitted. Do NOT rewrite this file wholesale: read it with startLine/endLine and change it with edit_file.]`;
          truncatedNote = "tail-truncated";
        }

        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            path,
            truncated: truncatedNote,
            content: text,
            totalLines: win.totalLines,
            ...(win.windowed
              ? { startLine: win.startLine, endLine: win.endLine }
              : {}),
          },
          durationMs: Date.now() - started,
          summary: path,
        };
      }

      case "read_files": {
        const requested = Array.isArray(args.paths) ? args.paths : [];
        const paths = requested
          .filter((p): p is string => typeof p === "string" && p.trim() !== "")
          .map((p) => p.trim());
        if (paths.length === 0) {
          return fail(
            'read_files needs "paths": an array of repo-relative paths, e.g. { "paths": ["src/a.ts", "src/b.ts"] }.'
          );
        }
        const files: Array<Record<string, unknown>> = [];
        const notRead: string[] = [];
        // ONE budget for the whole call. Twelve files' worth of text is a
        // context blowout, and a file that did not fit is reported as unread
        // rather than half-returned: a partial file is what makes a model
        // rewrite code it never saw.
        let budget = TOOL_RESULT_MAX_CHARS;
        for (const path of paths.slice(0, MAX_READ_FILES)) {
          if (signal?.aborted) return fail("Aborted by the user.");
          // Delegated to read_file on purpose: the workspace-first rule, the
          // binary and too-large cases, and the tail-truncation warning are
          // implemented once, in one place, and a batch must behave exactly the
          // way a single read does.
          const one = await executeToolCall(
            { id: `${call.id}:${path}`, name: "read_file", arguments: JSON.stringify({ path }) },
            ctx
          );
          const payload = one.data as { content?: unknown } | undefined;
          const size = typeof payload?.content === "string" ? payload.content.length : 0;
          if (!one.ok || size > budget) {
            notRead.push(path);
            continue;
          }
          budget -= size;
          files.push({ path, ...(one.data as Record<string, unknown>) });
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            files,
            requested: paths.length,
            ...(notRead.length > 0
              ? {
                  notRead,
                  note:
                    "These were NOT returned: the read failed, or the call's shared result budget ran out. Read one on its own with read_file rather than assuming what it holds.",
                }
              : {}),
          },
          durationMs: Date.now() - started,
          summary: summarize(call.name, args, true),
        };
      }

      case "find_files": {
        const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
        if (!pattern) {
          return fail(
            'find_files needs "pattern", e.g. { "pattern": "**/*.test.ts" } or { "pattern": "*.spec.ts" }.'
          );
        }
        const subtree = typeof args.subtree === "string" ? args.subtree : "";
        const max =
          typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
            ? Math.min(Math.max(1, Math.floor(args.maxResults)), FIND_FILES_MAX_RESULTS)
            : FIND_FILES_DEFAULT_RESULTS;

        // The working copy is consulted FIRST: a file the agent created this
        // turn is a file it must be able to find again, and the repository tree
        // does not know about it yet.
        let entries: Array<{ path: string; type: string }> = [];
        try {
          const { selectWorkspace, useChatStore } = await import("@/stores/chat.store");
          const ws = selectWorkspace(useChatStore.getState(), ctx.conversationId ?? "");
          if (ws?.tree?.length) entries = ws.tree.map((e) => ({ path: e.path, type: e.type }));
        } catch {
          /* no store (tests, workers): fall through to the repository tree */
        }
        if (entries.length === 0) {
          const tree = await getRepoTree(token, repo.owner, repo.repo, repo.branch);
          if (signal?.aborted) return fail("Aborted by the user.");
          entries = tree.map((e) => ({ path: e.path, type: e.type }));
        }

        const matched = findMatchingPaths(entries, pattern, subtree).slice(0, max);
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            pattern,
            ...(subtree ? { subtree } : {}),
            matches: matched,
            totalMatches: matched.length,
            note:
              matched.length === 0
                ? "No path matched. A pattern with no slash matches a filename at ANY depth (`*.test.ts`); `src/**/*.ts` searches below src."
                : "Read the ones you need with read_file/read_files. To find what is INSIDE files, search_workspace finds content.",
          },
          durationMs: Date.now() - started,
          summary: summarize(call.name, args, true),
        };
      }

      case "search_web": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return fail("Missing required argument: query");
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
            ? Math.floor(args.limit)
            : SEARCH_DEFAULT_LIMIT;

        const outcome = await searchWeb(query, { signal, limit });
        if (!outcome.ok) return fail(outcome.error);
        if (signal?.aborted) return fail("Aborted by the user.");

        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            query: outcome.query,
            provider: outcome.provider,
            results: outcome.results,
            note:
              outcome.results.length === 0
                ? "Nothing matched. Rephrase the query (name the library or the exact error), or ask the user for the URL — do not guess one."
                : "These are leads, not answers: an excerpt can be from an older version than this project uses. Read the page with fetch_url before relying on it, and check the project's own version first.",
          },
          durationMs: Date.now() - started,
          summary: summarize(call.name, args, true),
        };
      }

      case "fetch_url": {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return fail("Missing required argument: url");
        const maxChars =
          typeof args.maxChars === "number" && Number.isFinite(args.maxChars) && args.maxChars > 0
            ? Math.floor(args.maxChars)
            : WEB_MAX_TEXT_CHARS;

        const fetched = await fetchWebDocument(url, { signal });
        if (!fetched.ok) return fail(fetched.error);
        if (signal?.aborted) return fail("Aborted by the user.");

        const page = flattenWebBody(fetched.body, fetched.contentType, maxChars);
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            url: fetched.requestedUrl,
            status: fetched.status,
            contentType: fetched.contentType,
            title: page.title,
            kind: page.kind,
            text: truncateForBudget(page.text),
            // Either limit is worth stating: the byte cap cut the response, or
            // the character budget cut the extracted text.
            truncated: page.truncated || fetched.bodyTruncated,
            // True when CORS forced the relay, which is the common case and
            // worth a caller knowing when a redirect or a final URL matters.
            viaRelay: fetched.viaProxy,
            redirected: fetched.redirectNote,
            note: page.note,
            statusNote:
              fetched.status >= 400
                ? `The server answered ${fetched.status}, so this is an error or refusal page rather than the content — read it as a diagnostic, not as the documentation.`
                : null,
          },
          durationMs: Date.now() - started,
          summary: summarize(call.name, args, true),
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

      case "read_skill": {
        // Skills are advertised in the system prompt as an index (name,
        // description, triggers) and their bodies load on demand here.
        // That keeps the instruction block small and byte-stable while
        // still making every skill available — and because the body
        // arrives as a normal tool result, it persists in the transcript
        // for the rest of the conversation.
        const requested = typeof args.name === "string" ? args.name.trim() : "";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const skills = await loadSkills();
        if (skills.length === 0) {
          return fail("No skills are available in this installation.");
        }

        const listLines = skills.map(
          (s) => `- ${s.name}${s.enabled ? " (active)" : ""}${s.description ? ` — ${s.description}` : ""}`
        );
        const catalog = `Available skills:\n${listLines.join("\n")}`;

        if (!requested && !query) {
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { skills: skills.map((s) => ({ name: s.name, description: s.description, enabled: s.enabled })), catalog },
            durationMs: Date.now() - started,
            summary: `${skills.length} skills`,
          };
        }

        if (!requested && query) {
          const matches = matchSkills(query, skills);
          if (matches.length === 0) {
            return {
              callId: call.id,
              name: call.name,
              ok: true,
              data: { matches: [], catalog, note: "No skill matches that description — proceed with your own judgement." },
              durationMs: Date.now() - started,
              summary: "no matching skill",
            };
          }
          // A single match is the answer — return its body, not just its name.
          if (matches.length === 1) {
            const only = matches[0]!;
            return {
              callId: call.id,
              name: call.name,
              ok: true,
              data: { name: only.name, description: only.description, content: only.content },
              durationMs: Date.now() - started,
              summary: only.name,
            };
          }
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: {
              matches: matches.map((s) => ({ name: s.name, description: s.description, triggers: s.triggers ?? [] })),
              note: "Several skills match — call read_skill with the name you want.",
            },
            durationMs: Date.now() - started,
            summary: `${matches.length} matches`,
          };
        }

        const skill = findSkill(skills, requested);
        if (!skill) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            data: {
              error: `No skill named \`${requested}\`. ${catalog}`,
            },
            durationMs: Date.now() - started,
            summary: `unknown skill: ${requested}`,
          };
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          data: {
            name: skill.name,
            description: skill.description,
            content: skill.content,
            note: skill.enabled
              ? "This skill is already active for every turn."
              : "Follow these instructions for the rest of this task.",
          },
          durationMs: Date.now() - started,
          summary: skill.name,
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
          // The steps read through this thread's working copy, so they are cached
          // against it (see tool-cache.ReadView) — a program must not replay a
          // peer agent's uncommitted file contents as its own step results.
          view: readViewFor(ctx.conversationId),
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

/**
 * Serializes a ToolCallResult into the wire-format content string.
 *
 * This is the single seam where externally-authored text reaches the
 * model, so it is also where the injection defence lives: results from
 * tools that carry repository content are wrapped in <untrusted-content>
 * tags, and the standing rule in the system prompt (lib/untrusted.ts)
 * tells the model what those tags mean. Wrapping happens LAST, after
 * truncation, so a truncation marker can never land outside the tags.
 */
export function serializeToolResult(result: ToolCallResult): string {
  const payload = result.ok ? result.data : { error: result.data };
  // Program results already carry a shaped `output` (which embeds the
  // per-step log) — send it as the payload; metadata would only add bulk.
  if (result.name === "run_tool_program" && typeof (payload as { output?: unknown }).output === "string") {
    const text = truncateForBudget(
      (payload as { output: string }).output,
      Math.max(TOOL_RESULT_MAX_CHARS, TOOL_PROGRAM_MAX_CHARS)
    );
    return wrapUntrusted(result.name, text);
  }
  const text = truncateForBudget(JSON.stringify(payload));
  return isUntrustedTool(result.name) ? wrapUntrusted(result.name, text) : text;
}
