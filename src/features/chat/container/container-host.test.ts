// ============================================================
// Container Host — What The Boot Has To Be Told
// ============================================================
// The host is the one module that talks to the SDK, so the interesting assertions
// are about the OPTIONS it boots with and about the calls it does NOT make: an
// option that is merely defaulted (preview error forwarding) silently removes a
// whole evidence channel, and a boot attempted on a page that cannot host a
// workspace costs the user seconds for an answer the headers already gave.
//
// The environment is faked by setting the two globals the probe reads, because
// `readWorkspaceEnvironment` is exactly the browser boundary and pretending a
// node process is an isolated document is the whole point of the seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containerStatus,
  ensureContainer,
  resetContainerHost,
  setContainerModuleLoader,
  type ContainerRuntime,
} from "./container-host";

const globals = globalThis as unknown as Record<string, unknown>;
let isolated: unknown;
let secure: unknown;

function fakeRuntime(): ContainerRuntime {
  return {
    mount: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    spawn: vi.fn(),
    on: vi.fn(() => () => {}),
    teardown: vi.fn(async () => {}),
  };
}

/** A page the probe will call isolated, without touching the real document */
function pretendIsolated(): void {
  globals.crossOriginIsolated = true;
  globals.isSecureContext = true;
}

beforeEach(() => {
  isolated = globals.crossOriginIsolated;
  secure = globals.isSecureContext;
  resetContainerHost();
});

afterEach(() => {
  globals.crossOriginIsolated = isolated;
  globals.isSecureContext = secure;
  setContainerModuleLoader(() => import("@webcontainer/api"));
  resetContainerHost();
});

describe("ensureContainer — booting once, with everything the tier depends on", () => {
  it("asks the runtime to forward preview errors, because that is the only runtime evidence there is", async () => {
    // Without this option the SDK forwards nothing from inside the preview and
    // the failure is silent in both directions: a healthy-looking preview and an
    // empty evidence note. It is a boot option, so it cannot be enabled later.
    pretendIsolated();
    const boot = vi.fn(async () => fakeRuntime());
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot } }) as unknown as typeof import("@webcontainer/api")
    );

    const runtime = await ensureContainer();
    expect(runtime).not.toBeNull();
    expect(boot).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledWith(
      expect.objectContaining({ forwardPreviewErrors: true })
    );
    expect(containerStatus().state).toBe("ready");
  });

  it("does not even load the SDK on a page that cannot host a workspace", async () => {
    globals.crossOriginIsolated = false;
    const loader = vi.fn(async () => {
      throw new Error("the SDK must not be imported");
    });
    setContainerModuleLoader(loader as unknown as () => Promise<typeof import("@webcontainer/api")>);

    const runtime = await ensureContainer();
    expect(runtime).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(containerStatus().state).toBe("unsupported");
    expect(containerStatus().reason).toMatch(/cross-origin isolated/);
  });

  it("boots once, and reuses the instance for every later call", async () => {
    pretendIsolated();
    const boot = vi.fn(async () => fakeRuntime());
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot } }) as unknown as typeof import("@webcontainer/api")
    );

    const first = await ensureContainer();
    const second = await ensureContainer();
    expect(first).toBe(second);
    expect(boot).toHaveBeenCalledTimes(1);
  });
});
