// ============================================================
// Boot Probe — Where A Browser Workspace Actually Stands
// ============================================================
// The workspace tier fails in ways that read alike and are nothing alike:
//
//   • the response is not cross-origin isolated (headers missing, or served by a
//     host that never got them) — the runtime iframe refuses to boot;
//   • isolation is fine and the runtime still will not boot (blocked by the CSP,
//     no network, a browser without the feature);
//   • isolation and boot are fine and the browser cannot run a command.
//
// Told only "the workspace failed", a user retries, and a model writes an
// apology. So the check is split the way the failure is: the ENVIRONMENT is read
// synchronously and reported as a fact about headers, and the BOOT is attempted
// once and reported as a stage. Both produce a sentence naming what to change.
//
// No user-agent sniffing anywhere in here, deliberately. An unsupported browser
// cannot satisfy the isolation check in the first place, so identity would only
// add a second, less reliable opinion about a question reality already answers —
// and it would be wrong for the next browser to ship the feature.
//
// Pure except for `readWorkspaceEnvironment`, which reads three globals and
// nothing else; `probeContainer` takes its runtime by injection so the browser
// boundary is testable with a fake.
// ============================================================

import { RUNTIME_ORIGIN } from "./isolation";

/** What the document says about itself, read from globals only */
export interface WorkspaceEnvironment {
  /** `window.crossOriginIsolated` — the browser's own verdict */
  isolated: boolean;
  /** Present only in isolated documents that may allocate shared memory */
  hasSharedArrayBuffer: boolean;
  /** A workspace is a compute tier: it has no business on an insecure origin */
  secure: boolean;
  /**
   * `document.crossOriginEmbedderPolicy` where the browser exposes it
   * ("require-corp", "credentialless", …). null when unknown.
   */
  coep: string | null;
}

export interface WorkspaceVerdict {
  supported: boolean;
  /** One line stating where things stand, safe to show a user */
  summary: string;
  /** Why not, in the user's terms */
  cause: string | null;
  /** What would change it */
  fix: string | null;
}

/**
 * Reads the environment. Browser-only: returns an unsupported verdict rather
 * than throwing when called where there is no document (a test, a worker).
 */
export function readWorkspaceEnvironment(): WorkspaceEnvironment {
  const globals = globalThis as Record<string, unknown>;
  const hasDocument = typeof document !== "undefined";
  const doc = hasDocument ? (document as Document & { crossOriginEmbedderPolicy?: string }) : null;
  return {
    isolated: globals.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    secure: globals.isSecureContext !== false,
    coep: typeof doc?.crossOriginEmbedderPolicy === "string" ? doc.crossOriginEmbedderPolicy : null,
  };
}

/**
 * The verdict, from the environment alone.
 *
 * Order matters: the insecure-origin case is reported first because an insecure
 * origin cannot be isolated at all, and telling a user to fix headers when the
 * real problem is `http://` would be a wasted afternoon.
 */
export function workspaceVerdict(env: WorkspaceEnvironment): WorkspaceVerdict {
  if (!env.secure) {
    return {
      supported: false,
      summary: "A browser workspace needs a secure origin (https or localhost).",
      cause: "This page is not running in a secure context.",
      fix: "Open the app over https, or on localhost.",
    };
  }
  if (!env.isolated) {
    // The common, load-bearing one: correct code, wrong response headers.
    return {
      supported: false,
      summary:
        "This page is not cross-origin isolated, so the workspace runtime cannot start. " +
        `It needs Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy on this response (and ${RUNTIME_ORIGIN} allowed in frame-src).`,
      cause:
        env.coep === null
          ? "The response carries no cross-origin isolation headers that this browser reports."
          : `The response's embedder policy is "${env.coep}", which does not isolate the document.`,
      fix: "Redeploy with the isolation headers, or run the app locally where the dev server serves them.",
    };
  }
  if (!env.hasSharedArrayBuffer) {
    return {
      supported: false,
      summary:
        "This browser reports an isolated page but does not expose SharedArrayBuffer, which the workspace runtime requires.",
      cause: "The browser withholds shared memory even when isolated.",
      fix: "Use a current desktop Chromium browser (Chrome, Edge, Brave, Arc).",
    };
  }
  return {
    supported: true,
    summary: "This page is cross-origin isolated, so a browser workspace can start here.",
    cause: null,
    fix: null,
  };
}

/** The minimal runtime surface the probe needs — a booted container, essentially */
export interface ProbeRuntime {
  /** Run one command; a non-zero exit is a result, not a thrown error */
  exec(command: string, args: string[]): Promise<{ exitCode: number; output: string }>;
  teardown(): Promise<void>;
}

export interface BootProbeDeps {
  boot: () => Promise<ProbeRuntime>;
  /** Defaults to the live environment; injected by tests */
  environment?: WorkspaceEnvironment;
}

export type BootProbeOutcome =
  | { ok: true; nodeVersion: string; environment: WorkspaceEnvironment }
  | {
      ok: false;
      /** Which stage failed: the page, the boot, or the command inside it */
      stage: "environment" | "boot" | "exec";
      summary: string;
      detail: string | null;
      environment: WorkspaceEnvironment;
    };

/**
 * Reads the environment, then boots once and asks the container for its Node
 * version.
 *
 * The boot is the expensive part and it is the only way to distinguish "the
 * headers are wrong" from "the headers are right and something else is wrong" —
 * which is the whole reason this exists as a script rather than as a paragraph
 * of documentation. Teardown runs in a `finally`: a probe that leaks a runtime
 * instance blocks every later boot in the same page.
 */
export async function probeContainer(deps: BootProbeDeps): Promise<BootProbeOutcome> {
  const environment = deps.environment ?? readWorkspaceEnvironment();
  const verdict = workspaceVerdict(environment);
  if (!verdict.supported) {
    return {
      ok: false,
      stage: "environment",
      summary: verdict.summary,
      detail: verdict.fix,
      environment,
    };
  }

  // Assigned in the `try` and returned from the `catch`, so there is no null
  // state to carry: a boot that fails does not reach the exec below.
  let runtime: ProbeRuntime;
  try {
    runtime = await deps.boot();
  } catch (error) {
    return {
      ok: false,
      stage: "boot",
      summary: "The workspace runtime refused to start in this page.",
      detail: error instanceof Error ? error.message : String(error),
      environment,
    };
  }

  try {
    const result = await runtime.exec("node", ["--version"]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        stage: "exec",
        summary: "The workspace started but could not run a command inside it.",
        detail: result.output.trim().slice(0, 400) || `exit ${result.exitCode}`,
        environment,
      };
    }
    return { ok: true, nodeVersion: result.output.trim(), environment };
  } catch (error) {
    return {
      ok: false,
      stage: "exec",
      summary: "The workspace started but running a command inside it failed.",
      detail: error instanceof Error ? error.message : String(error),
      environment,
    };
  } finally {
    // Best-effort: a teardown failure must not replace the outcome we learned.
    try {
      await runtime.teardown();
    } catch {
      // Intentionally ignored — see above.
    }
  }
}
