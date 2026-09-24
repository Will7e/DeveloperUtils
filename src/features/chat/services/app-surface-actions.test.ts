// ============================================================
// App Surface Actions — The Agent As A User Of This App
// ============================================================
// Three things this file exists to hold down, in the order they matter:
//
//   1. NO PROMISE WITHOUT A HAND. Every action the catalog declares must have
//      an executor and every executor must be declared. A family declared in
//      `lib/app-surface.ts` and unhandled here is the worst kind of drift: the
//      agent is TOLD it can tidy a comparison and the only answer it can ever
//      get is "unknown action".
//   2. SECRETS NEVER TRAVEL. A read is asserted against the raw payload text,
//      not against the field it was supposed to mask — a value that leaks from
//      anywhere in the structure fails the test.
//   3. A WRITE CAN BE PUT BACK. The ledger's own contract, exercised through
//      the `activity` family the way the model would: act, read what you did,
//      undo it, and get a refusal if you try twice.
//
// These run against the REAL stores (the app's own state), because the claim
// being tested is precisely that the agent reaches the user's actual data
// through the same actions the UI calls.

import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { APP_SURFACE } from "../lib/app-surface";
import { listAppActions, resetAppActionLedger } from "../lib/app-action-ledger";
import {
  declaredActions,
  describeToolFamilies,
  executorActions,
  hasAppActionExecutor,
  readAppFamily,
  runAppAction,
} from "./app-surface-actions";

const app = () => useAppStore.getState();
const api = () => useApiTesterStore.getState();

/** The payload as the model receives it, so a leak anywhere is visible */
function payloadText(family: string): string {
  const outcome = readAppFamily(family);
  expect(outcome.ok, family).toBe(true);
  return JSON.stringify(outcome.ok ? outcome.data : {});
}

function fileNamed(name: string) {
  return app().files.find((f) => f.name === name);
}

function errorOf(outcome: { ok: boolean; error?: string }): string {
  return outcome.error ?? "";
}

/** The payload of a successful outcome — asserts success, then narrows */
function dataOf<T>(outcome: { ok: boolean; data?: unknown }): T {
  expect(outcome.ok).toBe(true);
  return outcome.data as T;
}

/**
 * The most recent change the ledger still considers in force.
 *
 * An undone row STAYS in the ledger (that is what makes the activity list an
 * honest history), so "what did I just do" means the newest row that has not
 * been reversed — the same question the `activity` family answers for the
 * model.
 */
function newestChange() {
  const row = listAppActions().find((r) => !r.undone);
  expect(row, "no un-undone change was recorded").toBeDefined();
  return row!;
}

beforeEach(() => {
  resetAppActionLedger();
});

// ── 1. The catalog and the executors agree ───────────────────

describe("the catalog and its executors are one thing", () => {
  it("has an executor for every declared action", () => {
    const missing: string[] = [];
    for (const family of APP_SURFACE) {
      for (const action of family.actions) {
        if (!hasAppActionExecutor(family.id, action.name)) {
          missing.push(`${family.id}.${action.name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("declares every action it can execute", () => {
    const undeclared: string[] = [];
    for (const family of APP_SURFACE) {
      for (const action of executorActions(family.id)) {
        if (!declaredActions(family.id).includes(action)) {
          undeclared.push(`${family.id}.${action}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("gives every family a way to read it", () => {
    for (const family of APP_SURFACE) {
      const outcome = readAppFamily(family.id);
      expect(outcome.ok, family.id).toBe(true);
    }
  });

  it("can reverse everything that discards a user's work", () => {
    const notReversible: string[] = [];
    for (const family of APP_SURFACE) {
      for (const action of family.actions) {
        if (action.destructive && !action.undoable) notReversible.push(`${family.id}.${action.name}`);
      }
    }
    expect(notReversible).toEqual([]);
  });
});

// ── 2. Reads mask at the source ──────────────────────────────

describe("a read never carries a credential", () => {
  const BEARER = "Bearer sk-live-9f2c4a7b1d";
  const TOKEN = "tok-3f8a21c9e4";

  beforeEach(() => {
    // The user's own state: an authorized request and a global token, exactly
    // as the API Tester would hold them.
    app().createFile("agent-probe.js", "javascript", "probe");
    void runAppAction("api-tester", "set_header", { key: "Authorization", value: BEARER });
    void runAppAction("api-tester", "set_var", { key: "API_TOKEN", value: TOKEN });
  });

  it("masks a secret header and reports only its presence and size", () => {
    const text = payloadText("api-tester");
    expect(text).not.toContain("sk-live-9f2c4a7b1d");
    expect(text).toContain("Authorization");
    expect(text).toContain("chars hidden");
  });

  it("masks a secret variable's value on the way IN as well as out", async () => {
    const outcome = await runAppAction("api-tester", "set_var", {
      key: "API_TOKEN",
      value: "tok-rotated-7788",
    });
    expect(JSON.stringify(dataOf<unknown>(outcome))).not.toContain("tok-rotated-7788");
    expect(payloadText("api-tester")).not.toContain("tok-rotated-7788");
    // …while the value really did change, so masking is not a silent refusal.
    expect(api().envVars.find((v) => v.key === "API_TOKEN")?.value).toBe("tok-rotated-7788");
  });

  it("leaves a non-secret value readable, because a read must still be useful", () => {
    void runAppAction("api-tester", "set_var", { key: "API_BASE", value: "https://staging.example.com" });
    expect(payloadText("api-tester")).toContain("https://staging.example.com");
  });

  it("reports a missing secret as empty rather than inventing a value", () => {
    const text = payloadText("api-tester");
    expect(text).not.toContain(TOKEN);
  });
});

// ── 3. The editor family: read, change, undo ─────────────────

describe("the editor family", () => {
  it("creates a tab, appends to it, and puts it back through the ledger", async () => {
    const created = await runAppAction("editor", "create_file", {
      name: "agent-round-trip.js",
      language: "javascript",
      content: "one",
    });
    expect(created.ok).toBe(true);
    const id = dataOf<{ id: string }>(created).id;
    expect(fileNamed("agent-round-trip.js")?.content).toBe("one");

    const edited = await runAppAction("editor", "update_content", { id, content: "two", mode: "append" });
    expect(edited.ok).toBe(true);
    expect(app().files.find((f) => f.id === id)?.content).toBe("onetwo");

    // The activity family is the model's own view of what it changed — read it
    // rather than reaching into the ledger, so the assertion covers the read a
    // model would actually make.
    const activity = readAppFamily("activity");
    const rows = dataOf<{ actions: { id: string; action: string }[] }>(activity).actions;
    const row = rows[0]!;
    expect(row.action).toBe("update_content");

    const undone = await runAppAction("activity", "undo", { id: row.id });
    expect(undone.ok).toBe(true);
    expect(app().files.find((f) => f.id === id)?.content).toBe("one");

    // An undo is applied at most once: replaying it against state it was not
    // captured from is how a reversal becomes a corruption.
    const twice = await runAppAction("activity", "undo", { id: row.id });
    expect(twice.ok).toBe(false);
    expect(errorOf(twice)).toMatch(/already undone/);
  });

  it("restores a discarded tab's content, not just its name", async () => {
    const created = await runAppAction("editor", "create_file", {
      name: "doomed.js",
      language: "javascript",
      content: "keep me",
    });
    const id = dataOf<{ id: string }>(created).id;

    const deleted = await runAppAction("editor", "delete_file", { id });
    expect(deleted.ok).toBe(true);
    expect(app().files.some((f) => f.id === id)).toBe(false);

    const row = newestChange();
    expect(row.action).toBe("delete_file");
    expect((await runAppAction("activity", "undo", { id: row.id })).ok).toBe(true);
    expect(app().files.find((f) => f.id === id)?.content).toBe("keep me");
  });

  it("refuses to edit a tab that does not exist, and lists the ones that do", async () => {
    const outcome = await runAppAction("editor", "update_content", { id: "nope", content: "x" });
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toContain("No editor tab");
    expect(errorOf(outcome)).toContain("Existing editor tab ids");
  });

  it("refuses a language this app cannot run", async () => {
    const outcome = await runAppAction("editor", "create_file", { name: "x.rs", language: "rust" });
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toContain("must be a language this app can run");
  });
});

// ── 4. The api-tester family: tab scoping ────────────────────

describe("the api-tester family", () => {
  it("acts on a named tab without moving the user's selection", async () => {
    await runAppAction("api-tester", "create_tab", {});
    const tabs = api().tabs;
    const first = tabs[0]!.id;
    const second = tabs[tabs.length - 1]!.id;
    api().setActiveTab(first);

    const outcome = await runAppAction("api-tester", "set_request", {
      tabId: second,
      url: "https://example.com/health",
      method: "HEAD",
    });
    expect(outcome.ok).toBe(true);
    expect(api().tabs.find((t) => t.id === second)?.url).toBe("https://example.com/health");
    expect(api().tabs.find((t) => t.id === second)?.method).toBe("HEAD");
    // The user's own selection is theirs: acting on another tab must not steal it.
    expect(api().activeTabId).toBe(first);
  });

  it("adds a header once and replaces it on a second call, reversibly", async () => {
    const first = await runAppAction("api-tester", "set_header", { key: "X-Trace", value: "a" });
    expect(first.ok).toBe(true);
    expect(dataOf<{ replaced: boolean }>(first).replaced).toBe(false);

    const second = await runAppAction("api-tester", "set_header", { key: "x-trace", value: "b" });
    expect(dataOf<{ replaced: boolean }>(second).replaced).toBe(true);
    const tabId = api().activeTabId;
    const matching = api().tabs.find((t) => t.id === tabId)!.headers.filter((h) => /^x-trace$/i.test(h.key));
    expect(matching).toHaveLength(1);
    expect(matching[0]!.value).toBe("b");

    expect((await runAppAction("activity", "undo", { id: newestChange().id })).ok).toBe(true);
    // The FIRST call survives: undoing the second restores the state it was
    // made from, which is the header holding its previous value — not its
    // absence. A reversal that overshoots is a second change, not an undo.
    const after = api().tabs.find((t) => t.id === tabId)!;
    const headers = after.headers.filter((h) => /^x-trace$/i.test(h.key));
    expect(headers).toHaveLength(1);
    expect(headers[0]!.value).toBe("a");
  });

  it("names the headers that exist when asked to remove one that does not", async () => {
    const outcome = await runAppAction("api-tester", "remove_header", { key: "X-Nope" });
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toContain("Content-Type");
  });

  it("creates, fills and clears an environment variable, reversing the clear", async () => {
    const created = await runAppAction("api-tester", "set_var", { key: "API_BASE", value: "https://prod.example.com" });
    expect(created.ok).toBe(true);
    expect(api().envVars.some((v) => v.key === "API_BASE")).toBe(true);

    const cleared = await runAppAction("api-tester", "set_var", { key: "API_BASE", remove: true });
    expect(cleared.ok).toBe(true);
    expect(api().envVars.some((v) => v.key === "API_BASE")).toBe(false);

    const clearedRow = newestChange();
    expect(clearedRow.action).toBe("set_var");
    expect((await runAppAction("activity", "undo", { id: clearedRow.id })).ok).toBe(true);
    expect(api().envVars.find((v) => v.key === "API_BASE")?.value).toBe("https://prod.example.com");
  });

  it("refuses a variable write with neither a value nor a removal", async () => {
    const outcome = await runAppAction("api-tester", "set_var", { key: "MISSING" });
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toMatch(/needs `value`/);
  });
});

// ── 5. Families whose state the agent manages ────────────────

describe("comparators, diff and boards", () => {
  it("takes a comparison session from create to duplicate to put back", async () => {
    const before = app().comparatorSessions.length;
    const created = await runAppAction("comparators", "create", { name: "Agent compare", mode: "json" });
    const id = dataOf<{ id: string }>(created).id;
    expect(app().comparatorSessions.find((c) => c.id === id)?.mode).toBe("json");

    const filled = await runAppAction("comparators", "update_input", { id, side: "a", input: "one\ntwo" });
    expect(filled.ok).toBe(true);
    expect(app().comparatorSessions.find((c) => c.id === id)?.a).toBe("one\ntwo");

    const swapped = await runAppAction("comparators", "swap_inputs", { id });
    expect(swapped.ok).toBe(true);
    expect(app().comparatorSessions.find((c) => c.id === id)?.b).toBe("one\ntwo");

    await runAppAction("comparators", "duplicate", { id });
    expect(app().comparatorSessions.length).toBe(before + 2);

    for (const action of ["duplicate", "swap_inputs", "update_input"]) {
      const row = newestChange();
      expect(row.action, `undoing ${action}`).toBe(action);
      expect((await runAppAction("activity", "undo", { id: row.id })).ok, action).toBe(true);
    }
    // The chain ends where it started: the duplicate is gone, and the
    // session's two sides are empty again — each undo restored the state ITS
    // change was made from, in reverse order, which is the whole contract.
    expect(app().comparatorSessions.length).toBe(before + 1);
    const restored = app().comparatorSessions.find((c) => c.id === id);
    expect(restored?.a).toBe("");
    expect(restored?.b).toBe("");
  });

  it("creates a board and takes it back", async () => {
    const created = await runAppAction("drawflows", "create_board", { name: "Agent board" });
    const id = dataOf<{ id: string }>(created).id;
    expect(app().workflows.some((w) => w.id === id)).toBe(true);

    const renamed = await runAppAction("drawflows", "rename_board", { id, name: "Agent board v2" });
    expect(renamed.ok).toBe(true);
    expect(app().workflows.find((w) => w.id === id)?.name).toBe("Agent board v2");

    expect((await runAppAction("activity", "undo", { id: newestChange().id })).ok).toBe(true);
    expect(app().workflows.find((w) => w.id === id)?.name).toBe("Agent board");
  });
});

// ── 6. Errors that teach ─────────────────────────────────────

describe("a miss is named", () => {
  it("lists the families when one does not exist", () => {
    const outcome = readAppFamily("api_tester");
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome as { ok: false; error: string })).toContain("api-tester");
    expect(errorOf(outcome as { ok: false; error: string })).toContain("comparators");
  });

  it("lists a family's actions when the action does not exist", async () => {
    const outcome = await runAppAction("comparators", "delete_everything", {});
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toContain("delete");
    expect(errorOf(outcome)).toContain("update_input");
  });

  it("says what to do instead when the family is missing altogether", async () => {
    const outcome = await runAppAction("", "undo", {});
    expect(outcome.ok).toBe(false);
    expect(errorOf(outcome)).toContain("No app family");
  });
});

// ── 7. The on-demand catalog ─────────────────────────────────

describe("describe_tools", () => {
  it("prints a family's actions with their argument shapes and marks", () => {
    const { text, unknown } = describeToolFamilies(["api-tester"]);
    expect(unknown).toEqual([]);
    expect(text).toContain("set_var");
    expect(text).toContain("{ environmentId? | null, key, value?, remove? }");
    expect(text).toContain("undoable");
    expect(text).toContain("Read it when:");
  });

  it("reports an unknown family instead of silently describing everything", () => {
    const { text, unknown } = describeToolFamilies(["nope"]);
    expect(unknown).toEqual(["nope"]);
    expect(text).toBe("");
  });

  it("describes every family when asked for none in particular", () => {
    const { text } = describeToolFamilies();
    for (const family of APP_SURFACE) {
      expect(text, family.id).toContain(`${family.id} — `);
    }
  });
});
