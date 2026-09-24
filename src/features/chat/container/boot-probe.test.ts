// ============================================================
// Boot Probe Tests — The Stage, Not Just The Failure
// ============================================================
// These assertions are about the DIAGNOSIS, because the diagnosis is the feature.
// A probe that reports "the workspace did not start" has the same value as the
// error it replaced; each case below pins which stage failed and what the user is
// told to change.

import { describe, it, expect, vi } from "vitest";
import {
  probeContainer,
  workspaceVerdict,
  type ProbeRuntime,
  type WorkspaceEnvironment,
} from "./boot-probe";
import { RUNTIME_ORIGIN } from "./isolation";

const GOOD: WorkspaceEnvironment = {
  isolated: true,
  hasSharedArrayBuffer: true,
  secure: true,
  coep: "credentialless",
};

function runtime(over: Partial<ProbeRuntime> = {}): ProbeRuntime {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, output: "v22.14.0\n" })),
    teardown: vi.fn(async () => {}),
    ...over,
  };
}

describe("workspaceVerdict — the environment as a fact about headers", () => {
  it("accepts an isolated, secure page with shared memory", () => {
    const verdict = workspaceVerdict(GOOD);
    expect(verdict.supported).toBe(true);
    expect(verdict.cause).toBeNull();
  });

  it("reports an insecure origin before anything else, because isolation is impossible without it", () => {
    // Both problems are present; the one that cannot be fixed by a header wins,
    // otherwise the user is sent to fix headers on an http:// page forever.
    const verdict = workspaceVerdict({ ...GOOD, secure: false, isolated: false });
    expect(verdict.supported).toBe(false);
    expect(verdict.summary).toContain("secure origin");
    expect(verdict.fix).toContain("https");
  });

  it("names the missing headers when the page is not isolated", () => {
    const verdict = workspaceVerdict({ ...GOOD, isolated: false, coep: null });
    expect(verdict.supported).toBe(false);
    expect(verdict.summary).toContain("not cross-origin isolated");
    expect(verdict.summary).toContain("Cross-Origin-Opener-Policy");
    expect(verdict.summary).toContain(RUNTIME_ORIGIN);
    expect(verdict.fix).toContain("Redeploy");
  });

  it("reports the embedder policy it actually saw, rather than just its absence", () => {
    // A COEP of `unsafe-none` is a different repair from no header at all, and
    // the value is what makes that visible.
    const verdict = workspaceVerdict({ ...GOOD, isolated: false, coep: "unsafe-none" });
    expect(verdict.cause).toContain("unsafe-none");
  });

  it("tells a user whose browser withholds shared memory to use a Chromium browser", () => {
    const verdict = workspaceVerdict({ ...GOOD, hasSharedArrayBuffer: false });
    expect(verdict.supported).toBe(false);
    expect(verdict.fix).toContain("Chromium");
  });
});

describe("probeContainer — which stage failed", () => {
  it("does not boot at all when the environment is wrong, and says so as the environment stage", async () => {
    const boot = vi.fn(async () => runtime());
    const outcome = await probeContainer({
      boot,
      environment: { ...GOOD, isolated: false, coep: null },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("environment");
    // The expensive, user-visible half must not run when a header is the problem.
    expect(boot).not.toHaveBeenCalled();
  });

  it("distinguishes a refused boot from a wrong page", async () => {
    const outcome = await probeContainer({
      boot: async () => {
        throw new Error("WebContainer API is not supported in this browser");
      },
      environment: GOOD,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("boot");
    expect(outcome.detail).toContain("not supported");
  });

  it("distinguishes a container that cannot run commands from one that cannot start", async () => {
    const outcome = await probeContainer({
      boot: async () => runtime({ exec: async () => ({ exitCode: 127, output: "node: not found\n" }) }),
      environment: GOOD,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("exec");
    expect(outcome.detail).toContain("not found");
  });

  it("reports the Node version it found, which is the claim the tier rests on", async () => {
    const outcome = await probeContainer({ boot: async () => runtime(), environment: GOOD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodeVersion).toBe("v22.14.0");
  });

  it("always tears the runtime down, including when the command failed", async () => {
    // A leaked instance blocks every later boot in the same page, so this is the
    // difference between one failure and a dead tab.
    const teardown = vi.fn(async () => {});
    await probeContainer({
      boot: async () => runtime({ exec: async () => ({ exitCode: 1, output: "boom" }), teardown }),
      environment: GOOD,
    });
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("keeps the outcome it learned when teardown itself fails", async () => {
    const outcome = await probeContainer({
      boot: async () =>
        runtime({
          teardown: async () => {
            throw new Error("teardown failed");
          },
        }),
      environment: GOOD,
    });
    expect(outcome.ok).toBe(true);
  });
});
