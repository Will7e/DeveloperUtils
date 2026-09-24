// ============================================================
// Mount Plan Tests — What Reaches The Container, And Why Not
// ============================================================
// The container's filesystem is the boundary this feature hands to third-party
// code, so the tests that matter are the ones about what does NOT cross it — and
// about the omission being visible to whoever reads the result afterwards.

import { describe, it, expect } from "vitest";
import { MOUNT_MAX_FILES, describeMount, planMount } from "./mount-plan";

const base = (path: string, content = "x") => ({ path, content });

describe("planMount — the tree", () => {
  it("nests flat paths into directories", () => {
    const plan = planMount({
      base: [base("package.json", "{}"), base("src/index.ts", "export {}"), base("src/lib/util.ts", "//")],
      changes: [],
    });
    const src = plan.tree["src"] as { directory: Record<string, unknown> };
    expect(Object.keys(plan.tree).sort()).toEqual(["package.json", "src"]);
    expect(Object.keys(src.directory).sort()).toEqual(["index.ts", "lib"]);
    const index = src.directory["index.ts"] as { file: { contents: string } };
    expect(index.file.contents).toBe("export {}");
  });

  it("lets a change win over the base, and a deletion remove the file", () => {
    const plan = planMount({
      base: [base("a.ts", "old"), base("gone.ts", "bye")],
      changes: [
        { path: "a.ts", content: "new", status: "modified" },
        { path: "gone.ts", content: null, status: "deleted" },
      ],
    });
    const a = plan.tree["a.ts"] as { file: { contents: string } };
    expect(a.file.contents).toBe("new");
    expect(plan.tree["gone.ts"]).toBeUndefined();
    expect(plan.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("produces the same tree from the same revision, whatever order the input arrives in", () => {
    // A snapshot keyed by revision has to describe a filesystem anybody can
    // reproduce; an order-dependent tree would make that claim false.
    const files = [base("b/two.ts"), base("a.ts"), base("b/one.ts"), base("c/d/e.ts")];
    const forward = planMount({ base: files, changes: [] });
    const reversed = planMount({ base: [...files].reverse(), changes: [] });
    expect(JSON.stringify(forward.tree)).toBe(JSON.stringify(reversed.tree));
    expect(forward.files.map((f) => f.path)).toEqual([...forward.files.map((f) => f.path)].sort());
  });

  it("reports an empty plan rather than an empty tree with no explanation", () => {
    const plan = planMount({ base: [], changes: [] });
    expect(plan.empty).toBe(true);
    expect(describeMount(plan)).toContain("nothing to mount");
  });
});

describe("planMount — the exclusions, each with its reason", () => {
  it("keeps a secret-shaped file out, and says why in terms of who can read the tree", () => {
    const plan = planMount({ base: [base(".env", "TOKEN=1"), base("src/.env.local", "A=2")], changes: [] });
    expect(plan.files).toEqual([]);
    expect(plan.skipped.map((s) => s.code)).toEqual(["secret", "secret"]);
    expect(plan.skipped[0]?.message).toContain("not mounted");
    expect(plan.skipped[0]?.message).toContain("dev server");
  });

  it("keeps an env TEMPLATE, which looks secret and holds no values", () => {
    // Over-reaching here is what gets a rule switched off; reading `.env.example`
    // is how a workspace learns which keys a project expects.
    const plan = planMount({ base: [base(".env.example", "API_KEY=changeme")], changes: [] });
    expect(plan.files.map((f) => f.path)).toEqual([".env.example"]);
    expect(plan.skipped).toEqual([]);
  });

  it("refuses a path that tries to leave the workspace", () => {
    const plan = planMount({ base: [], changes: [{ path: "../../etc/passwd", content: "x", status: "added" }] });
    expect(plan.files).toEqual([]);
    expect(plan.skipped[0]?.code).toBe("unsafe-path");
  });

  it("refuses .git even though a container is not the user's disk", () => {
    // The container has no git, so the hooks argument is weaker here — but the
    // rule is shared with the runner that writes to a real tree, and one
    // implementation of containment is the point.
    const plan = planMount({ base: [], changes: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh", status: "added" }] });
    expect(plan.files).toEqual([]);
    expect(plan.skipped[0]?.code).toBe("protected-path");
  });

  it("stops at the byte ceiling and reports the file it dropped", () => {
    const big = "a".repeat(2_000);
    const plan = planMount({
      base: [base("one.ts", big), base("two.ts", big)],
      changes: [],
      maxBytes: 3_000,
    });
    expect(plan.files.map((f) => f.path)).toEqual(["one.ts"]);
    expect(plan.skipped[0]?.code).toBe("too-large");
    expect(plan.skipped[0]?.message).toContain("partial tree");
  });

  it("stops at the file ceiling and reports it", () => {
    const many = Array.from({ length: MOUNT_MAX_FILES + 3 }, (_, i) => base(`f${i}.ts`));
    const plan = planMount({ base: many, changes: [] });
    expect(plan.files).toHaveLength(MOUNT_MAX_FILES);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped[0]?.code).toBe("too-many");
  });
});

describe("describeMount — a claim that carries its own omissions", () => {
  it("states size in the units a person reads", () => {
    const plan = planMount({ base: [base("a.ts", "x".repeat(2_048))], changes: [] });
    expect(describeMount(plan)).toBe("Workspace mounted: 1 file (2 KiB).");
  });

  it("says how many were skipped, because a silent omission is the failure mode", () => {
    const plan = planMount({
      base: [base("a.ts"), base(".env", "T=1"), base("b/.env.production", "T=2")],
      changes: [],
    });
    const line = describeMount(plan);
    expect(line).toContain("1 file");
    expect(line).toContain("2 skipped");
    expect(line).toContain(".env");
  });
});
