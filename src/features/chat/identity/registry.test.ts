// ============================================================
// Registry Contract — Every Cache Declares What It Holds
// ============================================================
// The transition bus is only as good as the set of caches that listen to it.
// The bug this file guards against is not a wrong release but a MISSING one: a
// module-level cache added in a later change, holding repository-derived state,
// that nothing invalidates — which is exactly how a published document or a
// proof outlived the repository it described.
//
// So this test reads the source tree and requires every module-level container
// cache under features/chat to be either
//
//   • REGISTERED — its module calls registerScopedResource, and the name it
//     registered is listed here; or
//   • EXEMPT — listed with a reason, because it genuinely has no repository to
//     be a copy of (rate-limit counters, pub/sub subscriber lists, a promise map
//     that empties itself).
//
// The list below is a lockfile, and it is meant to be edited in the same commit
// as a new cache rather than after an incident. Adding a cache without touching
// this file fails the suite, with the file and the variable named in the error.
//
// The scan covers container caches (`new Map`/`Set`/`WeakMap`/`WeakSet` at
// module top level). Module-level scalars with an explicit per-turn reset are a
// narrower problem and are not covered here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { registeredResources } from "./scoped-resources";

// Loading these modules is what performs the registrations, so they are imported
// for their side effects — a cache registers exactly when the code that holds it
// loads, and this test is where that claim is checked.
import "../lib/github-client";
import "../lib/tool-cache";
import "../lib/verification-ledger";
import "../workspace/repo-base";
import "../workspace/workspace";
import "../services/ask-user";
import "../lib/repo-instructions";
import "../lib/app-action-ledger";
import "../services/turn-prep";
import "../session/turn-engine";

const CHAT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A module-level container cache: `const foo = new Map<...>()` — a container
 * created EMPTY, and therefore filled later, by something.
 *
 * The emptiness is the whole discriminator, and it is a good one: a lookup table
 * is always constructed with its contents (`new Set(["a", "b"])`), so it cannot
 * vary after load and has nothing to release. A cache is constructed empty and
 * grows. That distinction keeps this scan at thirteen findings instead of
 * matching every static table in the codebase — and a check that noisy is a
 * check somebody deletes.
 *
 * The end-of-line anchor matters as much as the emptiness: it is what stops
 * `new Map(Object.entries(x).map(() => ...))` — which contains a literal `()`
 * inside a callback — from reading as an empty construction.
 *
 * Line-based, on purpose: a container whose type arguments span lines is not
 * matched, which is a miss rather than a false report.
 */
const DECLARATION =
  /^(?:export )?(?:const|let) (\w+)(?::[^=]+)? = new (?:Map|Set|WeakMap|WeakSet)(?:<.*>)?\(\s*\)\s*;?\s*$/;

/**
 * Caches that ARE registered, with the resource name their module declared.
 *
 * Two entries can point at one resource: the GitHub tree cache keeps its stamps
 * in a second map, and one release covers both.
 */
const REGISTERED: Record<string, string> = {
  "workspace/workspace.ts:saveTimers": "workspace.pending-saves",
  "workspace/repo-base.ts:resident": "repo-base.tree",
  "lib/github-client.ts:treeCache": "github-client.tree",
  "lib/github-client.ts:treeCacheStamps": "github-client.tree",
  "lib/tool-cache.ts:cache": "tool-cache.results",
  "lib/verification-ledger.ts:ledger": "verification-ledger.events",
  "services/ask-user.ts:waiters": "ask-user.parked-questions",
  "services/turn-prep.ts:fingerprintCache": "turn-prep.project-fingerprint",
  "services/turn-prep.ts:envSkillStateByConversation": "turn-prep.env-skill-state",
  "services/turn-prep.ts:toolSignalStateByConversation": "turn-prep.tool-signal-state",
  "lib/app-action-ledger.ts:entries": "app-action-ledger.entries",
  "lib/skill-activity.ts:byConversation": "skill-activity.records",
  "session/turn-engine.ts:sessions": "session.turn",
  "container/preview-bridge.ts:sessions": "preview-bridge.sessions",
};

/**
 * Caches that hold nothing that belongs to a repository, each with its reason.
 *
 * A reason is required, not a boolean: the value of the list is that a reader
 * can disagree with a specific claim.
 */
const EXEMPT: Record<string, string> = {
  "identity/scoped-resources.ts:resources":
    "the registry itself — it IS the list of what to release",
  "identity/bindings.ts:records":
    "the store of record for bindings; releasing it on a transition would delete the identity every transition is computed from",
  "identity/bindings.ts:listeners":
    "subscriber list for the binding store's change notification; nothing repository-derived",
  "context/tokenizer.ts:TOOL_SCHEMA_CACHE":
    "a WeakMap keyed by tool-definition OBJECTS, so its lifetime is theirs — it cannot be reached by a repository, and it evicts itself",
  "lib/search-endpoint.ts:rateBuckets":
    "rate-limit counters, keyed by client rather than by repository, with their own reset window",
  "services/compaction.ts:inflight":
    "in-flight compaction promises, removed when they settle",
  "services/turn-prep.ts:warnedToolsIssues":
    "once-per-session warning dedupe over tool names, not over repository state",
  "lib/availability.ts:observed":
    "capability states (workspace booted, web search configured) with a one-minute TTL — facts about this machine, not copies of any repository's state",
  "session/session-host.worker.ts:ports":
    "worker port bookkeeping inside the session worker",
  "session/turn-log.ts:subscribers":
    "pub/sub subscriber list, not a cache",
  "lib/availability.ts:capabilityListeners":
    "pub/sub subscriber list for the observed-capability notification; holds callbacks, never state — the states it notifies about are the already-exempt `observed` map beside it",
  "lib/verification-ledger.ts:listeners":
    "pub/sub subscriber list for the ledger's change notification, so the header chip re-reads without polling; holds callbacks, never evidence — the evidence itself is the registered `ledger` map above, and releasing one must not clear the other",
  "lib/skill-activity.ts:listeners":
    "pub/sub subscriber list for the skill-activity notification, so the header's skills card re-reads without polling; holds callbacks, never state — the records it notifies about are the registered `byConversation` map beside it",
  "lib/model-catalog.ts:endpointsCache":
    "serving facts about a MODEL — which providers offer it, their published prices, uptime and tool support — keyed by model id with a ten-minute TTL; a property of the provider, identical for every thread and every repository, so nothing a transition invalidates",
  "lib/model-catalog.ts:endpointsInFlight":
    "in-flight endpoint requests, keyed by model id and removed in the fetch's `finally`, so it empties itself and cannot hold repository state",
  "lib/model-catalog.ts:endpointListeners":
    "pub/sub subscriber list for the endpoints cache's change notification, so the header's serving line re-reads without polling; holds callbacks, never state — the answers it notifies about are the already-exempt `endpointsCache` map beside it",
  "lib/app-tools.ts:runLanes":
    "the snippet runner's per-language promise chain from `withRunLane`; it holds in-flight RUNS, not their results, so nothing in it is derived from a thread-on-repository — the sandbox worker it serializes onto is app-wide and keeps no state between runs, and a transition has nothing here to release",
  "container/container-host.ts:listeners":
    "pub/sub subscriber list for the workspace status (booting, ready, the preview URL), so the UI re-reads without polling; holds callbacks, never filesystem state — the runtime they describe is the registered `container.runtime` resource below, which the same module releases",
  "container/container-host.ts:eventListeners":
    "pub/sub subscriber list for workspace RUNTIME events (server-ready, preview console messages); holds callbacks, never state, and is cleared with the runtime it belongs to — the events themselves are consumed as they arrive and are not cached",
  "container/preview-bridge.ts:listeners":
    "pub/sub subscriber list for the preview status (starting, running, the dev server's URL); holds callbacks, never state — the console evidence it notifies about lives in the `state` scalar beside it, which is released with the mounted tree by the container host's own registered resource",
  "container/preview-control-bridge.ts:pending":
    "in-flight preview-control requests, keyed by request id and removed when the reply or the timeout settles — it empties itself and holds no repository state",
  "container/process-registry.ts:processes":
    "live background processes keyed by id: the entries hold the command the model chose and the process handle, and the module's own `workspace-released` subscription kills and clears every entry the moment the lease moves — the release the transition bus would ask for happens there, driven by the same event",
  "services/auto-verify.ts:timers":
    "pending auto-verify debounce timers keyed by conversation id; each removes itself when it fires or is cancelled, and holds no repository state — the check reads the store at run time",
  "services/auto-verify.ts:inFlight":
    "in-flight auto-verify promises, removed in the run's `finally`, so it empties itself and cannot hold repository state",
  "container/preview-bridge.ts:reloadRestartPending":
    "one-shot auto-restart offers (repo keys) seeded once per page load from the persisted preview records; each entry is consumed by the page's claim or simply never claimed — it holds no repository state and nothing here can be served as if current",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      out.push(full);
    }
  }
  return out;
}

/** Every module-level container cache in the tree, as `path:name` */
function declaredCaches(): Map<string, { file: string; line: number }> {
  const found = new Map<string, { file: string; line: number }>();
  for (const file of sourceFiles(CHAT_ROOT)) {
    const rel = relative(CHAT_ROOT, file).split("\\").join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      const match = DECLARATION.exec(text);
      if (match) found.set(`${rel}:${match[1]}`, { file: rel, line: index + 1 });
    });
  }
  return found;
}

describe("scoped-resource registry", () => {
  it("holds exactly the resources the codebase registers", () => {
    // A lockfile, so a registration cannot be quietly dropped — and so this list
    // and the source tree are checked against each other rather than each
    // against somebody's memory.
    expect(registeredResources().map((r) => r.name).sort()).toEqual([
      "app-action-ledger.entries",
      "ask-user.parked-questions",
      "container.runtime",
      "github-client.tree",
      "preview-bridge.sessions",
      "repo-base.tree",
      "repo.instructions",
      "session.turn",
      "skill-activity.records",
      "tool-cache.results",
      "turn-prep.env-skill-state",
      "turn-prep.project-fingerprint",
      "turn-prep.tool-signal-state",
      "verification-ledger.events",
      "workspace.pending-saves",
    ]);
  });

  it("gives every resource a scope that says what a transition can invalidate", () => {
    const scopes = new Set(["binding", "repo", "thread", "url"]);
    for (const resource of registeredResources()) {
      expect(scopes.has(resource.scope), `${resource.name} has scope ${resource.scope}`).toBe(true);
    }
  });

  it("accounts for every module-level cache in features/chat", () => {
    // A cache that is neither registered nor exempt is repository-derived state
    // with nothing to release it, which is the bug class this whole module
    // exists to close.
    const unexplained: string[] = [];
    for (const [key, where] of declaredCaches()) {
      if (REGISTERED[key] || EXEMPT[key]) continue;
      unexplained.push(`${where.file}:${where.line} — \`${key.split(":").pop()}\``);
    }

    expect(
      unexplained,
      "A module-level cache must declare itself. Register it with registerScopedResource " +
        "(and list it in REGISTERED), or add it to EXEMPT with a reason that says why it " +
        "holds nothing derived from a thread-on-repository."
    ).toEqual([]);
  });

  it("keeps both maps free of entries for caches that are gone", () => {
    // The other direction, and the one that lets a list like this rot: an entry
    // whose cache was renamed or deleted is a release that silently does nothing
    // forever, or an exemption nobody can judge any more.
    const declared = declaredCaches();
    const stale = [...Object.keys(REGISTERED), ...Object.keys(EXEMPT)].filter(
      (key) => !declared.has(key)
    );
    expect(stale, "These entries name caches that no longer exist — update the maps.").toEqual([]);
  });
});
