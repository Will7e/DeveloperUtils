// ============================================================
// Workspace Mount — A Repository At One Commit, As A Container Tree
// ============================================================
// The bridge between the two halves of this feature that never see each other:
// the workspace (a lazy overlay of the files something has asked for, which is
// the right shape for type checking) and the browser workspace (which needs the
// project, because `npm test` walks it).
//
// So the tree is hydrated from the repository listing instead — bounded, with
// every bound reported — and then composed with the thread's change set. Both
// halves already exist and are tested (`tree-source.ts`, `mount-plan.ts`); this
// module is the composition, and it is the ONLY place that decides which files
// the container gets. Two callers need it for different reasons — `run_command`
// to execute a command, the preview to start a dev server — and a second
// implementation would be a second answer to "what is in this workspace".
//
// Transport is injected (`read`), deliberately: the composition is pure enough to
// test against a fake directory, and the caller decides what a failed read MEANS
// (a 404 and a rate limit are the same shape here and different problems to a
// user).
// ============================================================

import type { WorkspaceState } from "../types";
import { collectChanges } from "../workspace/workspace";
import { planMount, type MountPlan } from "./mount-plan";
import { hydrateTree } from "./tree-source";

export interface MountPlanResult {
  plan: MountPlan;
  /** Lines the caller must surface: omissions, caps, unreadable files */
  notes: string[];
}

export async function planWorkspaceMount(input: {
  ws: WorkspaceState;
  read: (path: string) => Promise<string | null>;
  readBinary?: (path: string) => Promise<Uint8Array | null>;
}): Promise<{ ok: true; result: MountPlanResult } | { ok: false; error: string }> {
  let hydrated;
  try {
    hydrated = await hydrateTree({
      entries: input.ws.tree,
      read: input.read,
      ...(input.readBinary ? { readBinary: input.readBinary } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: `the repository's files could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const plan = planMount({
    base: hydrated.base,
    changes: collectChanges(input.ws).map((change) => ({
      path: change.path,
      content: change.content,
      status: change.status,
    })),
  });
  if (plan.empty) {
    return { ok: false, error: "no files could be read from this revision, so there is nothing to run against" };
  }

  // Every omission is stated, in the same breath as the size. A command that
  // fails because a file was never mounted is otherwise reported as a failing
  // change, and that is the expensive mistake this whole tier could make.
  const notes = [...hydrated.notes];

  // The hydrator's own exclusions, summarized by reason rather than enumerated:
  // a project's `node_modules` is thousands of entries and listing them would
  // bury the three lines that matter. Secret-shaped paths are the exception —
  // they are named, because "something was left out" is not enough when the
  // something is what a dev server would need to start.
  if (hydrated.skipped.length > 0) {
    const counts = new Map<string, number>();
    for (const skip of hydrated.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
    const summary = [...counts.entries()]
      .slice(0, 4)
      .map(([reason, count]) => `${count} ${reason}`)
      .join("; ");
    const secrets = hydrated.skipped.filter((skip) => skip.reason.startsWith("secret-shaped"));
    notes.push(
      `${hydrated.skipped.length} file(s) in this revision were not fetched into the browser workspace: ${summary}.` +
        (secrets.length > 0
          ? ` Secret-shaped paths never enter a workspace (${secrets
              .slice(0, 3)
              .map((skip) => skip.path)
              .join(", ")}${secrets.length > 3 ? ", …" : ""}): report anything that needs one rather than asking for it.`
          : "")
    );
  }

  if (plan.skipped.length > 0) {
    notes.push(
      `${plan.skipped.length} file(s) are not in the browser workspace: ${plan.skipped
        .slice(0, 4)
        .map((skip) => `${skip.path} (${skip.code})`)
        .join(", ")}${plan.skipped.length > 4 ? ", …" : ""}. A failure that names one of them is not a failure of the change.`
    );
  }
  return { ok: true, result: { plan, notes } };
}
