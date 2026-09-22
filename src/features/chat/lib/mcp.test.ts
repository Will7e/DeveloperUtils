// ============================================================
// MCP Client — Protocol Tests
// ============================================================
// The network is injected, so every awkward corner of streamable
// HTTP is exercised without a server: SSE framing, keep-alive
// comments, session-id negotiation, JSON-RPC error envelopes,
// HTTP failures, and the CORS diagnosis a browser client must
// produce when fetch reports nothing useful.

import { describe, it, expect } from "vitest";
import {
  MCP_MAX_SERVERS,
  MCP_PROTOCOL_VERSION,
  MCP_RESULT_MAX_CHARS,
  McpError,
  activeServers,
  callServerTool,
  diagnoseFetchFailure,
  findServer,
  listAllTools,
  listServerTools,
  normalizeToolCallResult,
  normalizeToolList,
  openSession,
  parseJsonRpcBody,
  parseMcpServersJson,
  serializeMcpServers,
  unwrapJsonRpc,
} from "./mcp";
import type { McpServerConfig } from "../types";

/** Minimal fetch Response stand-in (only what the client touches) */
function fakeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  const headers = init.headers ?? { "content-type": "application/json" };
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

/** Records every request and answers from a scripted queue */
function scriptedFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return await next();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const rpc = (result: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

/** initialize + the initialized notification (the handshake) */
function handshakeResponses() {
  return [
    () =>
      fakeResponse(rpc({ protocolVersion: MCP_PROTOCOL_VERSION }), {
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
      }),
    () => fakeResponse("", { status: 202, headers: { "content-type": "text/plain" } }),
  ];
}

/** A whole session: handshake + the tools/list answer */
function sessionResponses(listBody: string) {
  return [...handshakeResponses(), () => fakeResponse(listBody)];
}

const server: McpServerConfig = { id: "linear", name: "Linear", url: "https://mcp.example.com" };

describe("parseMcpServersJson", () => {
  it("treats empty or missing config as no servers", () => {
    expect(parseMcpServersJson("")).toEqual({ servers: [] });
    expect(parseMcpServersJson(null)).toEqual({ servers: [] });
    expect(parseMcpServersJson("   ")).toEqual({ servers: [] });
  });

  it("reports invalid JSON instead of throwing", () => {
    const out = parseMcpServersJson("{ not json");
    expect(out.servers).toEqual([]);
    expect(out.error).toBeTruthy();
  });

  it("accepts a single object as well as an array", () => {
    const out = parseMcpServersJson('{"name":"Linear","url":"https://mcp.example.com"}');
    expect(out.servers).toHaveLength(1);
    expect(out.servers[0]!.name).toBe("Linear");
    expect(out.servers[0]!.id).toBe("linear");
  });

  it("derives a missing name from the host", () => {
    const out = parseMcpServersJson('[{"url":"https://mcp.linear.app/sse"}]');
    expect(out.servers[0]!.name).toBe("mcp.linear.app");
    expect(out.servers[0]!.id).toBe("mcp-linear-app");
  });

  it("keeps a supplied apiKey and drops blank ones", () => {
    const out = parseMcpServersJson(
      '[{"url":"https://a.example.com","apiKey":"  tok  "},{"url":"https://b.example.com","apiKey":"   "}]'
    );
    expect(out.servers[0]!.apiKey).toBe("tok");
    expect(out.servers[1]!.apiKey).toBeUndefined();
  });

  it("skips entries with no url and rejects non-http urls", () => {
    expect(parseMcpServersJson('[{"name":"x"},{"url":"https://ok.example.com"}]').servers).toHaveLength(1);
    const bad = parseMcpServersJson('[{"url":"file:///etc/passwd"}]');
    expect(bad.servers).toEqual([]);
    expect(bad.error).toContain("http(s)");
  });

  it("disambiguates colliding ids", () => {
    const out = parseMcpServersJson(
      '[{"name":"Linear","url":"https://a.example.com"},{"name":"Linear","url":"https://b.example.com"}]'
    );
    expect(out.servers.map((s) => s.id)).toEqual(["linear", "linear-2"]);
  });

  it("caps the server count", () => {
    const many = Array.from({ length: MCP_MAX_SERVERS + 4 }, (_, i) => ({
      name: `s${i}`,
      url: `https://s${i}.example.com`,
    }));
    expect(parseMcpServersJson(JSON.stringify(many)).servers).toHaveLength(MCP_MAX_SERVERS);
  });

  it("round-trips through serialization", () => {
    const text = serializeMcpServers([
      { id: "a", name: "A", url: "https://a.example.com", apiKey: "k" },
      { id: "b", name: "B", url: "https://b.example.com", enabled: false },
    ]);
    const back = parseMcpServersJson(text).servers;
    expect(back[0]).toMatchObject({ name: "A", url: "https://a.example.com", apiKey: "k" });
    expect(back[1]!.enabled).toBe(false);
    expect(serializeMcpServers([])).toBe("");
    expect(serializeMcpServers(undefined)).toBe("");
  });
});

describe("activeServers / findServer", () => {
  it("drops disabled and url-less servers", () => {
    const list: McpServerConfig[] = [
      { id: "a", name: "A", url: "https://a.example.com" },
      { id: "b", name: "B", url: "https://b.example.com", enabled: false },
      { id: "c", name: "C", url: "  " },
    ];
    expect(activeServers(list).map((s) => s.id)).toEqual(["a"]);
    expect(activeServers(undefined)).toEqual([]);
  });

  it("resolves by id or name, case-insensitively", () => {
    const list: McpServerConfig[] = [{ id: "linear", name: "Linear MCP", url: "https://l.example.com" }];
    expect(findServer(list, "LINEAR")?.id).toBe("linear");
    expect(findServer(list, "linear mcp")?.id).toBe("linear");
    expect(findServer(list, "nope")).toBeUndefined();
    expect(findServer(list, "  ")).toBeUndefined();
  });
});

describe("parseJsonRpcBody", () => {
  it("reads a plain JSON response", () => {
    const msg = parseJsonRpcBody(rpc({ ok: true }, 7), "application/json");
    expect(msg.id).toBe(7);
    expect(msg.result).toEqual({ ok: true });
  });

  it("reads a message out of an SSE body, ignoring comments and [DONE]", () => {
    const body = [
      ": keep-alive",
      "",
      "event: message",
      `data: ${rpc({ tools: [] }, 3)}`,
      "",
      "data: [DONE]",
    ].join("\n");
    const msg = parseJsonRpcBody(body, "text/event-stream");
    expect(msg.id).toBe(3);
  });

  it("skips unparsable data lines and reports when none is readable", () => {
    const msg = parseJsonRpcBody("data: {broken\ndata: " + rpc({ n: 1 }), "text/event-stream");
    expect(msg.result).toEqual({ n: 1 });
    expect(() => parseJsonRpcBody("data: nope", "text/event-stream")).toThrow(McpError);
  });

  it("rejects an empty body and non-JSON content", () => {
    expect(() => parseJsonRpcBody("   ", "application/json")).toThrow(/empty/i);
    expect(() => parseJsonRpcBody("<html>oops</html>", "application/json")).toThrow(/not JSON/i);
  });
});

describe("unwrapJsonRpc", () => {
  it("returns the result", () => {
    expect(unwrapJsonRpc({ result: 42 }, "tools/list")).toBe(42);
  });

  it("surfaces the server's own error text", () => {
    try {
      unwrapJsonRpc({ error: { code: -32601, message: "Method not found" } }, "tools/list");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("server");
      expect((err as McpError).message).toContain("Method not found");
    }
  });

  it("treats a missing result as a protocol fault", () => {
    expect(() => unwrapJsonRpc({}, "tools/list")).toThrow(/no result/i);
  });
});

describe("normalizeToolList", () => {
  it("keeps named tools with their schemas", () => {
    const tools = normalizeToolList({
      tools: [
        { name: "search", description: "find", inputSchema: { type: "object" } },
        { name: "  " },
        "nonsense",
        { description: "no name" },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({ name: "search", description: "find", inputSchema: { type: "object" } });
  });

  it("returns nothing for a malformed result", () => {
    expect(normalizeToolList(null)).toEqual([]);
    expect(normalizeToolList({ tools: "nope" })).toEqual([]);
  });
});

describe("normalizeToolCallResult", () => {
  it("joins text blocks", () => {
    const out = normalizeToolCallResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(out.text).toBe("a\nb");
    expect(out.isError).toBe(false);
  });

  it("names non-text blocks instead of dropping them silently", () => {
    const out = normalizeToolCallResult({ content: [{ type: "image", data: "…" }] });
    expect(out.text).toContain("image content omitted");
  });

  it("carries the server's error flag", () => {
    expect(normalizeToolCallResult({ content: [], isError: true }).isError).toBe(true);
  });

  it("falls back to JSON when there are no content blocks", () => {
    expect(normalizeToolCallResult({ structuredContent: { n: 1 } }).text).toBe(
      JSON.stringify({ structuredContent: { n: 1 } })
    );
  });

  it("truncates oversized output", () => {
    const out = normalizeToolCallResult({ content: [{ type: "text", text: "x".repeat(MCP_RESULT_MAX_CHARS + 50) }] });
    expect(out.text.length).toBeLessThan(MCP_RESULT_MAX_CHARS + 40);
    expect(out.text).toContain("[truncated]");
  });
});

describe("diagnoseFetchFailure", () => {
  it("passes an McpError through untouched", () => {
    const err = new McpError("kept", "protocol");
    expect(diagnoseFetchFailure(err, "https://x.example.com")).toBe(err);
  });

  it("names the timeout when the request was aborted", () => {
    const err = new DOMException("aborted", "AbortError");
    const out = diagnoseFetchFailure(err, "https://x.example.com");
    expect(out.kind).toBe("timeout");
    expect(out.message).toContain("did not respond");
  });

  it("explains that a TypeError means CORS or an unreachable host", () => {
    const out = diagnoseFetchFailure(new TypeError("Failed to fetch"), "https://x.example.com");
    expect(out.kind).toBe("cors");
    expect(out.message).toContain("CORS");
    expect(out.message).toContain("server side");
  });

  it("falls back to the error message", () => {
    const out = diagnoseFetchFailure(new Error("socket closed"), "https://x.example.com");
    expect(out.kind).toBe("network");
    expect(out.message).toBe("socket closed");
  });
});

describe("session handshake", () => {
  it("sends initialize then the initialized notification, and echoes the session id", async () => {
    const { calls, impl } = scriptedFetch(sessionResponses(rpc({ tools: [] })));
    const session = await openSession(server, { fetchImpl: impl });

    expect(session.sessionId).toBe("sess-1");
    const [initCall, notifyCall] = calls;
    const initBody = JSON.parse(String(initCall!.init.body));
    expect(initBody).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "InTab" } },
    });
    expect(typeof initBody.id).toBe("number");

    const notifyBody = JSON.parse(String(notifyCall!.init.body));
    expect(notifyBody.method).toBe("notifications/initialized");
    expect(notifyBody.id).toBeUndefined();
  });

  it("sends the api key as a bearer token and the session id on later calls", async () => {
    const { calls, impl } = scriptedFetch(
      sessionResponses(rpc({ tools: [] })).concat([() => fakeResponse(rpc({ content: [] }))])
    );
    const withKey: McpServerConfig = { ...server, apiKey: "secret" };
    const session = await openSession(withKey, { fetchImpl: impl });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers.Accept).toContain("text/event-stream");

    expect(session.sessionId).toBe("sess-1");
  });

  it("turns a non-2xx response into a server error naming the method", async () => {
    const { impl } = scriptedFetch([
      () => fakeResponse("nope", { status: 500, headers: { "content-type": "text/plain" } }),
    ]);
    await expect(openSession(server, { fetchImpl: impl })).rejects.toThrow(/HTTP 500.*initialize/i);
  });

  it("turns a JSON-RPC error into a server error", async () => {
    const { impl } = scriptedFetch([
      () => fakeResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "bad key" } })),
    ]);
    await expect(openSession(server, { fetchImpl: impl })).rejects.toThrow(/bad key/);
  });
});

describe("listServerTools / callServerTool", () => {
  it("lists tools from a server", async () => {
    const listBody = rpc({ tools: [{ name: "create_issue", description: "make one" }] });
    const { impl } = scriptedFetch(sessionResponses(listBody));
    const result = await listServerTools(server, { fetchImpl: impl });
    expect(result.error).toBeUndefined();
    expect(result.tools).toEqual([{ name: "create_issue", description: "make one" }]);
  });

  it("reports an unreachable server as data, not as a throw", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await listServerTools(server, { fetchImpl: impl });
    expect(result.tools).toEqual([]);
    expect(result.error).toContain("CORS");
  });

  it("lists every active server, keeping partial success", async () => {
    const ok = { id: "a", name: "A", url: "https://a.example.com" };
    const dead = { id: "b", name: "B", url: "https://b.example.com" };
    const listBody = rpc({ tools: [{ name: "t" }] });
    let calls = 0;
    const impl = (async (url: string) => {
      if (String(url).includes("b.example.com")) throw new TypeError("Failed to fetch");
      calls += 1;
      if (calls === 1) return fakeResponse(rpc({}), { headers: { "content-type": "application/json", "mcp-session-id": "s" } });
      if (calls === 2) return fakeResponse("", { status: 202, headers: { "content-type": "text/plain" } });
      return fakeResponse(listBody);
    }) as unknown as typeof fetch;

    const results = await listAllTools([ok, dead], { fetchImpl: impl });
    expect(results[0]!.tools).toHaveLength(1);
    expect(results[1]!.error).toBeTruthy();
  });

  it("forwards arguments to tools/call and returns the text", async () => {
    const { calls, impl } = scriptedFetch(
      handshakeResponses().concat([
        () => fakeResponse(rpc({ content: [{ type: "text", text: "created #42" }] })),
      ])
    );
    const outcome = await callServerTool(server, "create_issue", { title: "x" }, { fetchImpl: impl });
    expect(outcome).toEqual({ ok: true, text: "created #42" });
    const callBody = JSON.parse(String(calls[2]!.init.body));
    expect(callBody).toMatchObject({
      method: "tools/call",
      params: { name: "create_issue", arguments: { title: "x" } },
    });
  });

  it("marks a tool-level error as not ok", async () => {
    const { impl } = scriptedFetch(
      handshakeResponses().concat([
        () => fakeResponse(rpc({ content: [{ type: "text", text: "rate limited" }], isError: true })),
      ])
    );
    const outcome = await callServerTool(server, "create_issue", {}, { fetchImpl: impl });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe("rate limited");
  });

  it("reports a transport failure as an error outcome", async () => {
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const outcome = await callServerTool(server, "t", {}, { fetchImpl: impl });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe("");
    expect(outcome.error).toContain("CORS");
  });
});

describe("timeouts", () => {
  it("aborts a hung request and reports a timeout", async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await expect(openSession(server, { fetchImpl: impl, timeoutMs: 5 })).rejects.toThrow(
      /did not respond/i
    );
  });
});
