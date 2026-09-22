// ============================================================
// MCP Client — Streamable HTTP, No Local Daemon
// ============================================================
// Every other agent harness reaches MCP servers through a process it
// starts on the user's machine. InTab cannot and should not: it is a
// browser app, and "install a daemon" is the friction this product
// exists to remove. MCP's streamable-HTTP transport is a POST of JSON-RPC
// with an SSE-framed response — that is a fetch call, so a browser can
// be an MCP client directly.
//
// What that buys, and what it costs, stated honestly:
//
//   + no install, no local process, no port to open;
//   + servers reachable from the page work in every conversation;
//   − the server must allow the browser ORIGIN (CORS). Many do not. When
//     one refuses, the error says so in those words rather than surfacing
//     an opaque "failed to fetch" — a wrong diagnosis here wastes an
//     hour, and the fix (a CORS header, or a proxy) is on the server.
//
// Scope: the subset this harness needs — initialize, tools/list,
// tools/call. Not resources, prompts, or sampling. Tools come back as
// TEXT so they fit the existing tool-result transport unchanged.
//
// Pure where it matters: protocol parsing is separated from the network
// so the awkward parts (SSE framing, content blocks, error envelopes) are
// unit-testable without a server.

import type { McpServerConfig } from "../types";

/** Re-exported so callers can use the client without also reaching into types */
export type { McpServerConfig };

/** MCP protocol revision this client speaks */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** One request's deadline (a tool call can be slow) */
export const MCP_TIMEOUT_MS = 20_000;
/** Model-facing cap on one tool result */
export const MCP_RESULT_MAX_CHARS = 8_000;
/** Cap on servers contacted per discovery pass */
export const MCP_MAX_SERVERS = 8;
/** Cap on tools listed per server */
export const MCP_MAX_TOOLS_PER_SERVER = 60;

export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the arguments, forwarded to the model as-is */
  inputSchema?: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(
    message: string,
    /** Machine hint for the UI/log */
    public readonly kind: "config" | "network" | "cors" | "protocol" | "server" | "timeout"
  ) {
    super(message);
    this.name = "McpError";
  }
}

// ── Configuration parsing ───────────────────────────────────

/**
 * Parses the settings JSON. Accepted shape:
 *   [{ "name": "linear", "url": "https://…", "apiKey": "…" }, …]
 * (a single object is accepted too). Ids are derived when absent so a
 * hand-written config never has to invent one.
 */
export function parseMcpServersJson(raw: string | null | undefined): {
  servers: McpServerConfig[];
  error?: string;
} {
  if (!raw || !raw.trim()) return { servers: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { servers: [], error: "MCP configuration is not valid JSON." };
  }

  const list = Array.isArray(json) ? json : [json];
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const entry of list.slice(0, MCP_MAX_SERVERS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { id?: unknown; name?: unknown; url?: unknown; apiKey?: unknown; enabled?: unknown };
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      return { servers: [], error: `MCP server url must be http(s): ${url}` };
    }
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : hostOf(url);
    let id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : slug(name);
    let n = 2;
    while (seen.has(id)) id = `${slug(name)}-${n++}`;
    seen.add(id);
    servers.push({
      id,
      name,
      url,
      ...(typeof e.apiKey === "string" && e.apiKey.trim() ? { apiKey: e.apiKey.trim() } : {}),
      ...(e.enabled === false ? { enabled: false } : {}),
    });
  }

  return { servers };
}

/** Serializes servers back into the editable settings text */
export function serializeMcpServers(servers: McpServerConfig[] | undefined): string {
  if (!servers || servers.length === 0) return "";
  return JSON.stringify(
    servers.map((s) => ({
      name: s.name,
      url: s.url,
      ...(s.apiKey ? { apiKey: s.apiKey } : {}),
      ...(s.enabled === false ? { enabled: false } : {}),
    })),
    null,
    2
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}

/** Servers that should be contacted (enabled, non-empty url) */
export function activeServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  return (servers ?? []).filter((s) => s.enabled !== false && s.url.trim()).slice(0, MCP_MAX_SERVERS);
}

// ── Protocol parsing (pure) ─────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Reads one JSON-RPC message out of an HTTP response body.
 *
 * Microsoft-style MCP servers answer `application/json`; many answer
 * `text/event-stream`, where the message rides in `data:` lines and
 * keep-alive comments are noise. Both are handled here so the network
 * layer never has to care which it got.
 */
export function parseJsonRpcBody(rawText: string, contentType: string): JsonRpcMessage {
  const text = rawText.trim();
  if (!text) throw new McpError("The MCP server returned an empty response.", "protocol");

  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload) as JsonRpcMessage;
      } catch {
        continue;
      }
    }
    throw new McpError("The MCP server sent an event stream with no readable message.", "protocol");
  }

  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    throw new McpError("The MCP server returned a response that is not JSON.", "protocol");
  }
}

/** Extracts the successful result, or throws the server's own error */
export function unwrapJsonRpc(message: JsonRpcMessage, context: string): unknown {
  if (message.error) {
    const detail = message.error.message ?? `code ${message.error.code ?? "?"}`;
    throw new McpError(`MCP ${context} failed: ${detail}`, "server");
  }
  if (message.result === undefined) {
    throw new McpError(`MCP ${context} returned no result.`, "protocol");
  }
  return message.result;
}

/** Normalizes a `tools/list` result into descriptors */
export function normalizeToolList(result: unknown): McpToolDescriptor[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  const out: McpToolDescriptor[] = [];
  for (const t of tools.slice(0, MCP_MAX_TOOLS_PER_SERVER)) {
    if (typeof t !== "object" || t === null) continue;
    const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof tool.name !== "string" || !tool.name.trim()) continue;
    out.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object"
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
    });
  }
  return out;
}

/**
 * Flattens a `tools/call` result into model-facing text. MCP content is
 * an array of typed blocks; only text is carried (an image block has no
 * place in a tool row), and it says so rather than silently dropping it.
 */
export function normalizeToolCallResult(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: unknown; isError?: unknown } | null;
  const isError = r?.isError === true;
  const blocks = Array.isArray(r?.content) ? r!.content : [];

  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (typeof b.type === "string") parts.push(`[${b.type} content omitted — only text is supported]`);
  }

  const text = parts.length > 0 ? parts.join("\n") : JSON.stringify(result ?? null);
  return {
    text: text.length > MCP_RESULT_MAX_CHARS ? `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n…[truncated]` : text,
    isError,
  };
}

/** Turns a transport-level failure into a diagnosis the user can act on */
export function diagnoseFetchFailure(err: unknown, url: string): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return new McpError(
      `The MCP server at ${url} did not respond within ${Math.round(MCP_TIMEOUT_MS / 1000)}s.`,
      "timeout"
    );
  }
  if (err instanceof TypeError) {
    // fetch() reports CORS and DNS identically as a TypeError. Say both
    // possibilities instead of guessing one.
    return new McpError(
      `Could not reach the MCP server at ${url}. Either the server does not allow this browser origin (CORS) ` +
        `or the address is not reachable from the browser. CORS is the usual cause, and it must be fixed on the server side.`,
      "cors"
    );
  }
  return new McpError(
    err instanceof Error ? err.message : `Could not reach the MCP server at ${url}.`,
    "network"
  );
}

// ── Transport ───────────────────────────────────────────────

export interface McpSession {
  server: McpServerConfig;
  /** Session id returned by initialize, echoed on later requests */
  sessionId: string | null;
}

export interface McpClientDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

let requestSeq = 1000;

/**
 * Sends one JSON-RPC request and returns the unwrapped result.
 * `notification` calls get no response by design.
 */
async function sendRequest(
  session: McpSession,
  method: string,
  params: Record<string, unknown> | undefined,
  deps: McpClientDeps,
  notification = false
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const id = notification ? undefined : ++requestSeq;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (id !== undefined) body.id = id;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(session.server.apiKey ? { Authorization: `Bearer ${session.server.apiKey}` } : {}),
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? MCP_TIMEOUT_MS);
  try {
    const response = await doFetch(session.server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // A newly minted session id arrives on initialize's response
    const returnedSession = response.headers?.get?.("mcp-session-id");
    if (returnedSession) session.sessionId = returnedSession;

    if (notification) return undefined;

    if (!response.ok) {
      throw new McpError(
        `MCP server ${session.server.name} returned HTTP ${response.status} for ${method}.`,
        "server"
      );
    }
    const text = await response.text();
    const message = parseJsonRpcBody(text, response.headers?.get?.("content-type") ?? "");
    return unwrapJsonRpc(message, method);
  } catch (err) {
    throw diagnoseFetchFailure(err, session.server.url);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens a session: initialize + the initialized notification */
export async function openSession(
  server: McpServerConfig,
  deps: McpClientDeps = {}
): Promise<McpSession> {
  const session: McpSession = { server, sessionId: null };
  await sendRequest(
    session,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "InTab", version: "1.0.0" },
    },
    deps
  );
  await sendRequest(session, "notifications/initialized", undefined, deps, true);
  return session;
}

export interface McpServerTools {
  server: McpServerConfig;
  tools: McpToolDescriptor[];
  error?: string;
}

/** Lists the tools one server exposes (never throws — errors are data) */
export async function listServerTools(
  server: McpServerConfig,
  deps: McpClientDeps = {}
): Promise<McpServerTools> {
  try {
    const session = await openSession(server, deps);
    const result = await sendRequest(session, "tools/list", undefined, deps);
    return { server, tools: normalizeToolList(result) };
  } catch (err) {
    return {
      server,
      tools: [],
      error: err instanceof Error ? err.message : "The MCP server failed.",
    };
  }
}

/** Lists tools across every configured server (in parallel, bounded) */
export async function listAllTools(
  servers: McpServerConfig[],
  deps: McpClientDeps = {}
): Promise<McpServerTools[]> {
  return Promise.all(activeServers(servers).map((s) => listServerTools(s, deps)));
}

export interface McpToolCallOutcome {
  ok: boolean;
  text: string;
  /** Set when the call never reached the tool */
  error?: string;
}

/** Calls one tool on one server */
export async function callServerTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpClientDeps = {}
): Promise<McpToolCallOutcome> {
  try {
    const session = await openSession(server, deps);
    const result = await sendRequest(session, "tools/call", { name: toolName, arguments: args }, deps);
    const normalized = normalizeToolCallResult(result);
    return { ok: !normalized.isError, text: normalized.text };
  } catch (err) {
    return {
      ok: false,
      text: "",
      error: err instanceof Error ? err.message : "The MCP tool call failed.",
    };
  }
}

/** Finds a configured server by id or name (case-insensitive) */
export function findServer(
  servers: McpServerConfig[] | undefined,
  idOrName: string
): McpServerConfig | undefined {
  const needle = idOrName.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    activeServers(servers).find((s) => s.id.toLowerCase() === needle) ??
    activeServers(servers).find((s) => s.name.toLowerCase() === needle) ??
    undefined
  );
}
