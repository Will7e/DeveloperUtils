// ============================================================
// Container Runtime Release — Scoped To The Thread That Moved
// ============================================================
// The regression this file pins: the container runtime used to tear itself
// down on EVERY transition from EVERY thread. The runtime is app-wide (one
// page, one filesystem), but "app-wide" describes what it holds, not whose
// business a transition is — so deleting a chat on repo B tore down the
// workspace repo A's chat was running commands and a dev server in. The user
// saw it as "I closed one chat and the whole repository closed".
//
// The fix follows the rule the turn engine already stated: a release is
// scoped to the thread that moved. These tests drive REAL transitions
// through the binding store (not hand-built contexts), because the bug lived
// in what the transitions said, not in the release plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containerStatus,
  ensureContainer,
  resetContainerHost,
  setContainerModuleLoader,
  claimWorkspace,
  workspaceHolder,
  type ContainerRuntime,
} from "./container-host";
import { forgetThread, resetBindings, setAttachment } from "../identity/bindings";

const globals = globalThis as unknown as Record<string, unknown>;
let isolated: unknown;
let secure: unknown;

function fakeRuntime(): ContainerRuntime {
  return {
    mount: vi.fn(async () => {}),
    fs: {
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    },
    spawn: vi.fn(),
    on: vi.fn(() => () => {}),
    teardown: vi.fn(async () => {}),
  };
}

function pretendIsolated(): void {
  globals.crossOriginIsolated = true;
  globals.isSecureContext = true;
}

/** Boots the real host against a fake runtime and hands the workspace to `threadId` */
async function bootedWithHolder(threadId: string): Promise<ContainerRuntime> {
  pretendIsolated();
  const runtime = fakeRuntime();
  setContainerModuleLoader(
    async () => ({ WebContainer: { boot: vi.fn(async () => runtime) } }) as unknown as typeof import("@webcontainer/api")
  );
  await ensureContainer();
  const claimed = await claimWorkspace({ threadId, label: `thread ${threadId}` });
  expect(claimed.ok).toBe(true);
  return runtime;
}

beforeEach(() => {
  isolated = globals.crossOriginIsolated;
  secure = globals.isSecureContext;
  resetBindings();
  resetContainerHost();
});

afterEach(() => {
  globals.crossOriginIsolated = isolated;
  globals.isSecureContext = secure;
  setContainerModuleLoader(() => import("@webcontainer/api"));
  resetBindings();
  resetContainerHost();
});

describe("container.runtime — a transition ends the workspace only when its thread holds it", () => {
  it("keeps the workspace up when a DIFFERENT thread's chat is deleted", async () => {
    // The reported bug. Thread A holds the workspace; the user deletes a chat
    // on thread B (another repo, or no repo at all). The workspace was torn
    // down, which killed A's mounted tree, its in-flight commands and its dev
    // server — "closing a chat closed the whole repository".
    const runtime = await bootedWithHolder("thread-a");

    await setAttachment("thread-b", { owner: "acme", repo: "billing", branch: "main" });
    await forgetThread("thread-b");

    expect(workspaceHolder()?.threadId).toBe("thread-a");
    expect(runtime.teardown).not.toHaveBeenCalled();
    expect(containerStatus().state).toBe("ready");
  });

  it("keeps the workspace up when a different thread switches repositories", async () => {
    const runtime = await bootedWithHolder("thread-a");

    await setAttachment("thread-b", { owner: "acme", repo: "billing", branch: "main" });
    await setAttachment("thread-b", { owner: "acme", repo: "other", branch: "main" });

    expect(workspaceHolder()?.threadId).toBe("thread-a");
    expect(runtime.teardown).not.toHaveBeenCalled();
  });

  it("tears the workspace down when the thread HOLDING it is deleted", async () => {
    // The other direction, and the one that must keep working: the holder's
    // own binding move ends its claim — the tree it mounted described a
    // revision of a thread that is gone.
    const runtime = await bootedWithHolder("thread-a");
    await setAttachment("thread-a", { owner: "acme", repo: "web", branch: "main" });

    await forgetThread("thread-a");

    expect(runtime.teardown).toHaveBeenCalled();
    expect(workspaceHolder()).toBeNull();
  });

  it("tears the workspace down when the holder's repository changes", async () => {
    const runtime = await bootedWithHolder("thread-a");
    await setAttachment("thread-a", { owner: "acme", repo: "web", branch: "main" });

    await setAttachment("thread-a", { owner: "acme", repo: "other", branch: "main" });

    expect(runtime.teardown).toHaveBeenCalled();
    expect(workspaceHolder()).toBeNull();
  });
});
