// ============================================================
// App Actions — Executor Tests
// ============================================================
// The HTTP pair is the part of the app tool surface that can act on the
// world, so most of this file is about the two gates that make it safe:
// the URL policy (what may be reached) and the approval dialog (what may be
// changed). Everything that would touch the network is arranged to be
// REFUSED before a request is made — the tests must never send one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Typed through the generic rather than a stub implementation: an arrow
// function here would need parameter names it never reads, which the
// no-unused-vars rule rejects, and the defaults are set per test anyway.
const requestHttpApproval = vi.fn<
  (pending: unknown) => Promise<{ approved: boolean; note?: string }>
>();
const createWorkflow = vi.fn<(name: string, elements: unknown[]) => string>();
const applyHandoff = vi.fn<(payload: unknown) => boolean>();

vi.mock("@/stores/chat.store", () => ({
  useChatStore: { getState: () => ({ requestHttpApproval }) },
}));

vi.mock("@/stores/app.store", () => ({
  useAppStore: {
    getState: () => ({ createWorkflow, addToast: vi.fn() }),
  },
}));

vi.mock("@/services/handoff-bridge", () => ({
  applyHandoff: (payload: unknown) => applyHandoff(payload),
}));

import {
  OPEN_IN_TOOL_TARGETS,
  redactHeaders,
  runAppTool,
  runCreateDiagramTool,
  runHttpRequestTool,
  runHttpWriteTool,
  runOpenInToolTool,
} from "./app-actions";
import { APP_TOOLS } from "../lib/tool-registry";
import type { ToolName } from "../types";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  requestHttpApproval.mockResolvedValue({ approved: false });
  createWorkflow.mockReturnValue("wf-1");
  applyHandoff.mockReturnValue(true);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http_request — URL policy", () => {
  it("refuses a non-http scheme before anything is sent", async () => {
    const result = await runHttpRequestTool("c1", { method: "GET", url: "file:///etc/passwd" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/not an http\(s\) URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses cloud metadata endpoints even though localhost is allowed", async () => {
    const result = await runHttpRequestTool("c1", {
      method: "GET",
      url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a write method on the read-only tool, and points at the writer", async () => {
    const result = await runHttpRequestTool("c1", { method: "POST", url: "http://localhost:3000/x" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("http_write");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses header injection via a line break", async () => {
    const result = await runHttpRequestTool("c1", {
      method: "GET",
      url: "http://localhost:3000/x",
      headers: { "X-Ok": "fine\r\nX-Evil: 1" },
    });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("http_write — method and approval gates", () => {
  it("refuses a read method, pointing at http_request", async () => {
    const result = await runHttpWriteTool("c1", { method: "GET", url: "http://localhost:3000/x" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("http_request");
  });

  it("sends nothing when the user declines, and hands back their note", async () => {
    requestHttpApproval.mockResolvedValueOnce({ approved: false, note: "not that record" });
    const result = await runHttpWriteTool("c1", {
      method: "DELETE",
      url: "http://localhost:3000/records/7",
      why: "clean up the test record",
    });

    expect(requestHttpApproval).toHaveBeenCalledTimes(1);
    const pending = requestHttpApproval.mock.calls[0]![0] as Record<string, unknown>;
    // The dialog must describe exactly what would be sent.
    expect(pending).toMatchObject({
      method: "DELETE",
      url: "http://localhost:3000/records/7",
      why: "clean up the test record",
      conversationId: "c1",
    });

    expect(result.ok).toBe(false);
    const error = String((result.data as { error: string }).error);
    expect(error).toContain("not that record");
    expect(error).toMatch(/do not resend/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adds a JSON Content-Type when a body is present and none was given", async () => {
    requestHttpApproval.mockResolvedValueOnce({ approved: false });
    await runHttpWriteTool("c1", {
      method: "POST",
      url: "http://localhost:3000/records",
      body: '{"a":1}',
    });
    const pending = requestHttpApproval.mock.calls[0]![0] as {
      headers: Record<string, string>;
    };
    expect(pending.headers["Content-Type"]).toBe("application/json");
  });

  it("refuses a URL policy violation without ever asking the user", async () => {
    const result = await runHttpWriteTool("c1", {
      method: "POST",
      url: "http://metadata.google.internal/computeMetadata/v1/",
    });
    expect(result.ok).toBe(false);
    expect(requestHttpApproval).not.toHaveBeenCalled();
  });
});

describe("redactHeaders", () => {
  it("masks credential-shaped values and leaves ordinary ones alone", () => {
    const shown = redactHeaders({
      Authorization: "Bearer sk-super-secret-token",
      "X-Api-Key": "abcdef123456",
      Accept: "application/json",
    });
    expect(shown.Authorization).not.toContain("super-secret");
    expect(shown["X-Api-Key"]).not.toContain("123456");
    expect(shown.Accept).toBe("application/json");
  });
});

describe("create_diagram", () => {
  it("builds a board and reports its size", () => {
    const result = runCreateDiagramTool({
      name: "Request flow",
      nodes: [
        { id: "ui", label: "Client" },
        { id: "api", label: "API", detail: "Node" },
      ],
      edges: [{ from: "ui", to: "api", label: "HTTPS" }],
    });
    expect(result.ok).toBe(true);
    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const [name, elements] = createWorkflow.mock.calls[0]!;
    expect(name).toBe("Request flow");
    // two rectangles + two labels + one arrow + the title
    expect(elements!.length).toBe(6);
    expect(result.data).toMatchObject({ workflowId: "wf-1", nodes: 2, edges: 1 });
  });

  it("refuses duplicate node ids", () => {
    const result = runCreateDiagramTool({
      nodes: [
        { id: "a", label: "One" },
        { id: "a", label: "Two" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it("drops a dangling edge, draws the rest, and says what was dropped", () => {
    const result = runCreateDiagramTool({
      nodes: [
        { id: "a", label: "One" },
        { id: "b", label: "Two" },
      ],
      edges: [{ from: "a", to: "nope" }],
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ edges: 0, droppedEdges: ["a → nope"] });
  });

  it("refuses a spec over the node cap", () => {
    const nodes = Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const result = runCreateDiagramTool({ nodes });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("limit");
  });

  it("refuses an empty node list with the shape it expects", () => {
    const result = runCreateDiagramTool({ nodes: [] });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/at least one/);
  });

  it("scopes element ids per call, so two diagrams never merge on one board", () => {
    // Unscoped ids collide by construction (every diagram wanted
    // `agent-edge-0`), and Excalidraw treats elements with the same id as the
    // same element — the second diagram silently lost its arrows.
    const spec = {
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "a" }],
    };
    runCreateDiagramTool(spec);
    runCreateDiagramTool(spec);
    const first = createWorkflow.mock.calls[0]![1] as { id: string }[];
    const second = createWorkflow.mock.calls[1]![1] as { id: string }[];
    const idsOf = (els: { id: string }[]) => els.map((e) => e.id);
    expect(first.length).toBeGreaterThan(0);
    expect(idsOf(second).some((id) => idsOf(first).includes(id))).toBe(false);
  });
});

describe("open_in_tool", () => {
  it("refuses the chat itself with an explanation", async () => {
    const result = runOpenInToolTool({ target: "chat" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/already in it/);
    expect(applyHandoff).not.toHaveBeenCalled();
  });

  it("refuses an unknown target and lists the real ones", () => {
    const result = runOpenInToolTool({ target: "spreadsheet" });
    expect(result.ok).toBe(false);
    for (const target of OPEN_IN_TOOL_TARGETS) {
      expect(String((result.data as { error: string }).error)).toContain(target);
    }
  });

  it("loads a snippet into the compiler and navigates once", () => {
    const result = runOpenInToolTool({
      target: "compiler",
      code: "console.log(1)",
      fileName: "repro.js",
      language: "javascript",
    });
    expect(result.ok).toBe(true);
    expect(applyHandoff).toHaveBeenCalledTimes(1);
    expect(applyHandoff.mock.calls[0]![0]).toMatchObject({
      target: "compiler",
      compiler: { code: "console.log(1)", fileName: "repro.js", language: "javascript" },
    });
  });

  it("requires the fields its target needs", () => {
    expect(runOpenInToolTool({ target: "compiler" }).ok).toBe(false);
    expect(runOpenInToolTool({ target: "formatters", content: "{}" }).ok).toBe(false);
    expect(runOpenInToolTool({ target: "formatters", content: "{}", formatType: "yaml" }).ok).toBe(false);
    expect(runOpenInToolTool({ target: "formatters", content: "{}", formatType: "json" }).ok).toBe(true);
    expect(runOpenInToolTool({ target: "api-tester" }).ok).toBe(false);
    expect(runOpenInToolTool({ target: "api-tester", url: "http://localhost:3000" }).ok).toBe(true);
  });

  it("reports a rejected payload instead of claiming it opened", () => {
    applyHandoff.mockReturnValueOnce(false);
    const result = runOpenInToolTool({ target: "diff", original: "a", modified: "b" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/did not accept/);
  });

  it("navigates to drawflows without nodes instead of drawing a second board", () => {
    // The follow-up create_diagram tells the model to make. Requiring nodes
    // here made it pass the same spec again, and this tool CREATES a board —
    // so the user got the same diagram twice in two tabs.
    const result = runOpenInToolTool({ target: "drawflows" });
    expect(result.ok).toBe(true);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(applyHandoff).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ target: "drawflows", navigated: true });
  });

  it("still draws a board when nodes are given", () => {
    const result = runOpenInToolTool({
      target: "drawflows",
      name: "Flow",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(result.ok).toBe(true);
    expect(applyHandoff).toHaveBeenCalledTimes(1);
    const payload = applyHandoff.mock.calls[0]![0] as { workflow?: { elements: unknown[] } };
    expect(payload.workflow?.elements.length).toBe(6);
    expect(result.data).not.toMatchObject({ navigated: true });
  });
});

describe("runAppTool dispatch", () => {
  it("routes http_request", async () => {
    const result = await runAppTool("c1", "http_request", {
      method: "GET",
      url: "not-a-url",
    });
    expect(result.name).toBe("http_request");
    expect(result.ok).toBe(false);
  });

  it("reports a registry/dispatcher mismatch rather than throwing", async () => {
    const result = await runAppTool("c1", "read_file", { path: "src/a.ts" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/no executor wired/);
  });

  // Every app tool the model can be told about must have a line in the
  // dispatcher. A registry entry without one is the worst kind of drift: the
  // tool is advertised, documented and offered, and the only thing it can
  // ever answer is "no executor wired".
  it("routes every app tool the registry advertises", async () => {
    expect(APP_TOOLS.length).toBeGreaterThan(0);
    for (const tool of APP_TOOLS) {
      const name = tool.function.name as ToolName;
      const result = await runAppTool("c1", name, {});
      // Empty arguments are rejected by each executor's own validation. That
      // is the point: a routed tool ANSWERS, an unrouted one cannot.
      expect(
        String((result.data as { error?: string }).error ?? ""),
        `${name} is in the registry but not in the dispatcher`
      ).not.toMatch(/no executor wired/);
      expect(result.name).toBe(name);
    }
    // …and the pure five did not take their store/network siblings' place.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
