// ============================================================
// CI Plan — The Repository's Own Verification, Which Is Free
// ============================================================
// Every repository already has the toolchain, the secrets and the services
// its build needs, and one definition of "green" that everyone agrees on.
// That is why CI is the highest-value verification tier this product can
// reach without spending anything: no image to build, no language matrix to
// maintain, no compute bill, and it runs the polyglot, Docker and
// service-backed projects the browser tier can never touch.
//
// This module is the DECISION half — what to dispatch, on which ref, and how
// to read the answer. It stays pure and offline so every rule below is a
// unit test rather than a live run.
//
// Two limits are stated rather than hidden:
//
//   • workflows are read by PATTERN, not by a YAML parser (the app ships no
//     parser, and a repository's workflow can use the full language). So the
//     plan reports what it saw and what it could not, and a workflow that
//     only triggers on `push` is refused with the reason — not dispatched
//     and silently never run.
//   • a dispatch needs write access, so the caller must have established
//     that. This file assumes it and says so.
// ============================================================

export interface CiWorkflowFile {
  path: string;
  content: string;
}

export interface CiWorkflow {
  /** Path, which is how the API addresses it when the id is unknown */
  path: string;
  /** `name:` if the file declares one, else the file name */
  label: string;
  /** The file declares a `workflow_dispatch` trigger */
  dispatchable: boolean;
  /** The file declares a `schedule` trigger (so a manual run is not unusual) */
  scheduled: boolean;
  /** Job names, as seen — useful in the report, never relied on */
  jobs: string[];
}

export interface CiPlanInput {
  workflows: readonly CiWorkflowFile[];
  /** Ref to dispatch on — the agent's working branch */
  ref: string;
  /** First candidate to prefer, e.g. a workflow the user named */
  preferredPath?: string;
}

export type CiPlan =
  | {
      ok: true;
      workflow: CiWorkflow;
      ref: string;
      /** Requested inputs — none today, present so the shape does not change */
      inputs: Record<string, string>;
      reason: string;
    }
  | {
      ok: false;
      code:
        | "no-workflows"
        | "no-dispatchable-workflow"
        | "no-branch"
        | "preferred-not-found";
      /** A sentence for the user AND the model, naming the next action */
      message: string;
      /** What WAS found, so the model can propose an alternative */
      candidates: string[];
    };

/** Workflow files in a repository tree, wherever `.github` sits. */
export function ciWorkflowPaths(paths: readonly string[]): string[] {
  return paths.filter((path) =>
    /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)
  );
}

/**
 * Read one workflow file.
 *
 * Deliberately shallow, and the parser says so: `on:` is a key that can be a
 * string, a list, or a map, and only the map and list forms can carry
 * `workflow_dispatch`. A file whose trigger block cannot be read is reported
 * as NOT dispatchable, which fails closed — the failure mode of guessing is
 * dispatching a workflow that never runs, and waiting for it.
 */
export function parseCiWorkflow(file: CiWorkflowFile): CiWorkflow {
  const name = /^\s*name:\s*(.+?)\s*$/m.exec(file.content)?.[1];
  const triggerBlock = /^\s*on:\s*(.*)$([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(file.content)?.[0] ?? "";
  const inline = /^\s*on:\s*(.+?)\s*$/m.exec(file.content)?.[1] ?? "";
  const dispatchable =
    /\bworkflow_dispatch\b/.test(triggerBlock) || /\bworkflow_dispatch\b/.test(inline);
  const scheduled = /\bschedule\b/.test(triggerBlock) || /\bschedule\b/.test(inline);

  const jobs: string[] = [];
  const jobsBlock = /^jobs:\s*$([\s\S]*)/m.exec(file.content)?.[1] ?? "";
  for (const match of jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)) {
    if (match[1]) jobs.push(match[1]);
  }

  return {
    path: file.path,
    label: name ? name.replace(/^["']|["']$/g, "") : (file.path.split("/").pop() ?? file.path),
    dispatchable,
    scheduled,
    jobs,
  };
}

/**
 * Which workflow to run, or why none can be.
 *
 * Preference order, and the reasoning is about false confidence rather than
 * taste: a workflow the user NAMED first (they know their repository), then
 * the one whose name or path reads like verification, then the first
 * dispatchable file. A scheduled workflow is preferred over an unknown one
 * because a workflow that runs on a timer is one whose trigger is meant to
 * work unattended.
 */
export function planCiVerification(input: CiPlanInput): CiPlan {
  const workflows = input.workflows.map(parseCiWorkflow);
  const candidates = workflows.map((workflow) => workflow.path);

  if (!input.ref.trim()) {
    return {
      ok: false,
      code: "no-branch",
      message:
        "No branch to verify. CI runs against a ref, and the workspace has no working branch yet — push the change first, then verify.",
      candidates,
    };
  }
  if (workflows.length === 0) {
    return {
      ok: false,
      code: "no-workflows",
      message:
        "This repository has no GitHub Actions workflows, so there is nothing to dispatch. Verify locally instead, or add a workflow the project can run.",
      candidates,
    };
  }

  const dispatchable = workflows.filter((workflow) => workflow.dispatchable);
  if (input.preferredPath) {
    const preferred = workflows.find((workflow) => workflow.path === input.preferredPath);
    if (!preferred) {
      return {
        ok: false,
        code: "preferred-not-found",
        message: `No workflow at ${input.preferredPath}. Choose one of the workflows this repository has.`,
        candidates,
      };
    }
    if (!preferred.dispatchable) {
      return {
        ok: false,
        code: "no-dispatchable-workflow",
        message:
          `${preferred.path} does not declare \`workflow_dispatch\`, so it cannot be started on demand — ` +
          "dispatching it would report nothing while the run never appears. Add the trigger, or verify another way.",
        candidates: dispatchable.map((workflow) => workflow.path),
      };
    }
    return { ok: true, workflow: preferred, ref: input.ref.trim(), inputs: {}, reason: "named by the caller" };
  }

  if (dispatchable.length === 0) {
    return {
      ok: false,
      code: "no-dispatchable-workflow",
      message:
        `${workflows.length} workflow${workflows.length === 1 ? "" : "s"} found, but none declares \`workflow_dispatch\`, ` +
        "so none can be started on demand. Pushing the branch will still run them — that is the verification path this repository offers.",
      candidates,
    };
  }

  const preferVerification = dispatchable.find((workflow) =>
    /(test|ci|verify|check|build)/i.test(`${workflow.label} ${workflow.path}`)
  );
  if (preferVerification) {
    return {
      ok: true,
      workflow: preferVerification,
      ref: input.ref.trim(),
      inputs: {},
      reason: "its name reads like verification",
    };
  }
  const preferScheduled = dispatchable.find((workflow) => workflow.scheduled);
  if (preferScheduled) {
    return {
      ok: true,
      workflow: preferScheduled,
      ref: input.ref.trim(),
      inputs: {},
      reason: "it runs on a schedule, so its trigger works unattended",
    };
  }
  return {
    ok: true,
    workflow: dispatchable[0]!,
    ref: input.ref.trim(),
    inputs: {},
    reason: "the only workflow that can be started on demand",
  };
}

export type CiConclusion = "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | null;

export interface CiRun {
  id: number;
  /** "queued" | "in_progress" | "completed" | … */
  status: string;
  /** null while the run is still going */
  conclusion: CiConclusion;
  htmlUrl: string;
  name: string;
  headBranch: string;
  createdAt: string;
}

export interface CiVerdict {
  /** The verification verdict, in the same vocabulary run_command uses */
  status: "passed" | "failed" | "running" | "timed-out" | "unknown";
  evidence: string;
  /** True only when the conclusion is a definitive pass */
  authoritativelyGreen: boolean;
}

/**
 * What a run's state means, in the agent's own vocabulary.
 *
 * The load-bearing distinction is `authoritativelyGreen`: a neutral or
 * skipped run is a run that did nothing, and reporting it as verification is
 * exactly the false confidence this tier exists to remove. A still-running
 * run is neither.
 */
export function interpretCiRun(run: CiRun, elapsedMs: number): CiVerdict {
  if (run.status !== "completed") {
    const minutes = Math.round(elapsedMs / 60_000);
    return {
      status: "running",
      evidence: `CI run #${run.id} ("${run.name}") is ${run.status} after ${minutes}m — no verdict yet.`,
      authoritativelyGreen: false,
    };
  }
  switch (run.conclusion) {
    case "success":
      return {
        status: "passed",
        evidence: `CI run #${run.id} ("${run.name}") on ${run.headBranch} succeeded — ${run.htmlUrl}`,
        authoritativelyGreen: true,
      };
    case "neutral":
    case "skipped":
      return {
        status: "unknown",
        evidence:
          `CI run #${run.id} finished "${run.conclusion}", which means it did not actually check anything — ` +
          `${run.htmlUrl}. This is NOT verification.`,
        authoritativelyGreen: false,
      };
    case "cancelled":
      return {
        status: "failed",
        evidence: `CI run #${run.id} was cancelled — ${run.htmlUrl}`,
        authoritativelyGreen: false,
      };
    case "timed_out":
      return {
        status: "timed-out",
        evidence: `CI run #${run.id} timed out — ${run.htmlUrl}`,
        authoritativelyGreen: false,
      };
    case "action_required":
      return {
        status: "failed",
        evidence: `CI run #${run.id} needs a human to approve it (workflow approval or environment protection) — ${run.htmlUrl}`,
        authoritativelyGreen: false,
      };
    default:
      return {
        status: "failed",
        evidence: `CI run #${run.id} finished "${run.conclusion ?? "unknown"}" — ${run.htmlUrl}`,
        authoritativelyGreen: false,
      };
  }
}

/** Deadline beyond which waiting is not worth a turn */
export const CI_MAX_WAIT_MS = 15 * 60_000;
/** How often to ask, and to back off to — CI is externally rate limited */
export const CI_POLL_INTERVAL_MS = 10_000;
export const CI_POLL_MAX_INTERVAL_MS = 60_000;
