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
import { isCommittedEnvFilePath } from "../lib/sensitivity";
import { collectChanges } from "../workspace/workspace";
import { planMount, flattenTree, type MountPlan } from "./mount-plan";
import { hydrateTree } from "./tree-source";
import { diagnoseEnv } from "./env-doctor";
import { inferRepoEnvFromPublicLiterals, repoEnvKeys } from "./runtime-env";

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
  // bury the three lines that matter. Key material is the exception — it is
  // named, because "something was left out" is not enough when the something is
  // what a deploy script would need.
  if (hydrated.skipped.length > 0) {
    const counts = new Map<string, number>();
    for (const skip of hydrated.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
    const summary = [...counts.entries()]
      .slice(0, 4)
      .map(([reason, count]) => `${count} ${reason}`)
      .join("; ");
    const keyMaterial = hydrated.skipped.filter((skip) => skip.reason.startsWith("key material"));
    notes.push(
      `${hydrated.skipped.length} file(s) in this revision were not fetched into the browser workspace: ${summary}.` +
        (keyMaterial.length > 0
          ? ` Key material never enters a workspace (${keyMaterial
              .slice(0, 3)
              .map((skip) => skip.path)
              .join(", ")}${keyMaterial.length > 3 ? ", …" : ""}): report anything that needs one rather than asking for it.`
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

  // The counterpart of the omissions above: when the revision's own env files
  // made it into the tree, the agent is TOLD — its standing instruction says env
  // files never reach the workspace, and acting on the stale rule would have it
  // report a missing configuration that is in fact mounted and working.
  const committedEnv = plan.files.filter((file) => isCommittedEnvFilePath(file.path)).map((file) => file.path);
  if (committedEnv.length > 0) {
    notes.push(
      `This revision's committed env file(s) — ${committedEnv
        .slice(0, 3)
        .map((path) => `\`${path}\``)
        .join(", ")}${committedEnv.length > 3 ? ", …" : ""} — are mounted: they are part of the commit, so the workspace runs with the configuration the repository itself publishes. Values a user keeps only in their local (uncommitted) env file are a different matter: ask for those in conversation, never as a file.`
    );
  }

  // The doctor's verdict rides the mount notes, so a preview that fails for an
  // env reason is diagnosed BEFORE the failure instead of after it — and the
  // values the doctor inferred from public literals are persisted (once per
  // repo), so the next dev server starts with them without anyone asking.
  const treeFiles = flattenTree(plan.tree);
  const report = diagnoseEnv({
    files: treeFiles,
    packageJson: treeFiles.find((file) => file.path === "package.json")?.content as string | null ?? null,
    // The stored env satisfies references like a committed file does — and a
    // stored BARE service key also satisfies the referenced `VITE_`-prefixed
    // twin, because the spawn env synthesizes that twin from it.
    storedKeys: await repoEnvKeys(input.ws.owner, input.ws.repo),
  });
  if (report.inferred.length > 0) {
    const inferred = await inferRepoEnvFromPublicLiterals(input.ws.owner, input.ws.repo, report.inferred);
    if (inferred.keys.length > 0) {
      notes.push(
        `${inferred.keys.length} env value(s) were inferred from public literals in this repository (${inferred.keys
          .map((key) => `\`${key}\``)
          .join(", ")}) and stored for this repo's workspace — public-by-design endpoints only, never a secret.`
      );
    }
  }
  if (report.missingKeys.length > 0) {
    notes.push(
      `The code references env key(s) that exist nowhere in this repository or the stored env: ${report.missingKeys
        .map((key) => `\`${key}\``)
        .join(", ")}. Ask the user for exactly these in conversation (a paste is parsed and remembered per repo via set_env); never invent values.`
    );
  }
  if (report.findings.some((finding) => finding.kind === "blocked")) {
    const blocked = report.findings.find((finding) => finding.kind === "blocked")!;
    notes.push(blocked.message);
  }
  return { ok: true, result: { plan, notes } };
}
