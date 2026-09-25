// ============================================================
// Guardrail + Memory + PR Actions — Executor Tests
// ============================================================
// memory_search and secrets_scan read the workspace store, so a real
// store is driven through its own attach path (setAttachment +
// setWorkspace — the pattern github-collab-actions.test.ts uses).
// The GitHub calls are mocked at the transport boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github-collab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/github-collab")>();
  return { ...actual, findPullRequestForHead: vi.fn() };
});
vi.mock("../lib/github-write", () => ({ openPullRequest: vi.fn() }));

import { findPullRequestForHead } from "../lib/github-collab";
import { openPullRequest } from "../lib/github-write";
import { setAttachment } from "@/features/chat/identity/bindings";
import { useChatStore } from "@/stores/chat.store";
import { runMemorySearch, runSecretsScan } from "./agent-actions";
import { runCreatePullRequest } from "./github-collab-actions";
import type { RepoContext, WorkspaceState } from "../types";

const WEB: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 1 };
const TOKEN = "ghp_token_for_tests";

const errorOf = (result: { data: unknown }): string =>
  String((result.data as { error?: string }).error ?? "");

function workspaceFor(id: string, over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    conversationId: id,
    owner: WEB.owner,
    repo: WEB.repo,
    branch: WEB.branch,
    baseCommitSha: "base-sha",
    workingBranch: null,
    tree: [],
    files: {},
    updatedAt: 1,
    ...over,
  };
}

const memoryFile = (facts: string[]) => ({
  path: ".intab/memory.md",
  content: `# Project memory\n\n${facts.map((f) => `- ${f} (recorded 2026-01-01)`).join("\n")}\n`,
  baseContent: "",
  baseSha: null,
  status: "modified" as const,
  updatedAt: 1,
});

let conversationId = "";

beforeEach(async () => {
  conversationId = useChatStore.getState().createConversation("model-a");
  await setAttachment(conversationId, WEB);
  useChatStore.getState().setWorkspace(conversationId, workspaceFor(conversationId));
  useChatStore.setState({
    settings: { ...useChatStore.getState().settings, github: { ...useChatStore.getState().settings.github, token: TOKEN } },
  });
});

describe("memory_search", () => {
  it("lists facts recorded in the workspace's memory file", async () => {
    useChatStore.getState().setWorkspace(
      conversationId,
      workspaceFor(conversationId, {
        files: { ".intab/memory.md": memoryFile(["Tests run with `npm test` (vitest)", "Deploy uses `npm run build`"]) },
      })
    );
    const result = await runMemorySearch(conversationId, {});
    expect(result.ok).toBe(true);
    const data = result.data as { facts: string[]; total: number };
    expect(data.total).toBe(2);
    expect(data.facts[0]).toContain("npm test");
  });

  it("narrows by keyword and reports a clean miss readably", async () => {
    useChatStore.getState().setWorkspace(
      conversationId,
      workspaceFor(conversationId, {
        files: { ".intab/memory.md": memoryFile(["Tests run with `npm test`"]) },
      })
    );
    const hit = await runMemorySearch(conversationId, { query: "tests npm" });
    expect((hit.data as { facts: unknown[] }).facts).toHaveLength(1);

    const miss = await runMemorySearch(conversationId, { query: "deploy vercel" });
    expect((miss.data as { facts: unknown[] }).facts).toHaveLength(0);
    expect(String((miss.data as { note: string }).note)).toMatch(/No recorded fact matches/);
  });

  it("says so plainly when nothing has been recorded yet", async () => {
    const result = await runMemorySearch(conversationId, {});
    expect(result.ok).toBe(true);
    const data = result.data as { total: number; note: string };
    expect(data.total).toBe(0);
    expect(data.note).toMatch(/No project memory/);
    expect(data.note).toContain(".intab/memory.md");
  });
});

describe("secrets_scan", () => {
  it("finds a credential in the change set and redacts it", async () => {
    useChatStore.getState().setWorkspace(
      conversationId,
      workspaceFor(conversationId, {
        files: {
          "src/config.ts": {
            path: "src/config.ts",
            content: 'const TOKEN = "ghp_Abcdefghijklmnopqrstuvwxyz123456";',
            baseContent: "",
            baseSha: "x",
            status: "modified" as const,
            updatedAt: 1,
          },
        },
      })
    );
    const result = await runSecretsScan(conversationId, {});
    expect(result.ok).toBe(true);
    const data = result.data as { findings: Array<{ path: string; snippet: string }>; note: string };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]!.path).toBe("src/config.ts");
    // Redaction: the shape is reported, the value is not.
    expect(data.findings[0]!.snippet).not.toContain("ghp_Abcdefghijklmnopqrstuvwxyz123456");
    expect(data.note).toMatch(/push gate/);
  });

  it("scans provided text and reports clean honestly", async () => {
    // NB: the canonical AWS docs key (…EXAMPLE) is deliberately NOT used here —
    // the engine's placeholder filter correctly ignores it.
    const dirty = await runSecretsScan(conversationId, { text: 'api_key = "AKIAABCDEFGHIJKLMNOP"' });
    expect((dirty.data as { findings: unknown[] }).findings).toHaveLength(1);

    const clean = await runSecretsScan(conversationId, { text: "const greeting = 'hello';" });
    expect((clean.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect(String((clean.data as { note: string }).note)).toMatch(/No credential-shaped/);
  });

  it("reports an empty change set instead of failing", async () => {
    const result = await runSecretsScan(conversationId, {});
    expect(result.ok).toBe(true);
    expect((result.data as { files: number }).files).toBe(0);
  });
});

describe("create_pull_request", () => {
  it("refuses before any dialog when nothing has been pushed", async () => {
    const result = await runCreatePullRequest(conversationId, { title: "T" });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/push_changes first/);
  });

  it("refuses when the working branch IS the base", async () => {
    useChatStore
      .getState()
      .setWorkspace(conversationId, workspaceFor(conversationId, { workingBranch: "main" }));
    const result = await runCreatePullRequest(conversationId, { title: "T" });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/two different branches/);
  });

  it("reports an existing open PR instead of duplicating it", async () => {
    useChatStore
      .getState()
      .setWorkspace(conversationId, workspaceFor(conversationId, { workingBranch: "agent/fix-login" }));
    vi.mocked(findPullRequestForHead).mockResolvedValueOnce({
      number: 7,
      state: "open",
      url: "https://github.com/acme/web/pull/7",
    } as never);
    const result = await runCreatePullRequest(conversationId, { title: "Fix login" });
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; number: number };
    expect(data.status).toBe("already-open");
    expect(data.number).toBe(7);
    // And no approval dialog was shown for a no-op.
    expect(openPullRequest).not.toHaveBeenCalled();
  });

  it("opens the PR through the gate and reports the URL", async () => {
    useChatStore
      .getState()
      .setWorkspace(conversationId, workspaceFor(conversationId, { workingBranch: "agent/fix-login" }));
    vi.mocked(findPullRequestForHead).mockRejectedValueOnce(new Error("none"));
    vi.mocked(openPullRequest).mockResolvedValueOnce({
      number: 12,
      url: "https://api.github.com/repos/acme/web/pulls/12",
      htmlUrl: "https://github.com/acme/web/pull/12",
    });
    // Auto-approve the gate so the test does not need the UI.
    useChatStore.setState({
      requestHttpApproval: async () => ({ approved: true, auto: false }),
    });
    const result = await runCreatePullRequest(conversationId, { title: "Fix login", body: "Because." });
    expect(result.ok).toBe(true);
    const data = result.data as { status: string; number: number; url: string };
    expect(data.status).toBe("opened");
    expect(data.number).toBe(12);
    expect(data.url).toContain("acme/web/pull/12");
    expect(openPullRequest).toHaveBeenCalledWith("tok".length === 3 ? TOKEN : TOKEN, "acme", "web", "agent/fix-login", "main", "Fix login", "Because.");
  });
});
