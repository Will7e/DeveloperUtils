// ============================================================
// License Report — Parser Tests
// ============================================================
// Pure input/output: manifest text and lockfile text in, rows out.

import { describe, expect, it } from "vitest";
import { licenseReport } from "./license-report";

const MANIFEST = JSON.stringify({
  name: "app",
  license: "MIT",
  version: "1.0.0",
  dependencies: { react: "^18.0.0", "gpl-pkg": "^1.0.0" },
  devDependencies: { vitest: "^2.0.0" },
});

const LOCK = JSON.stringify({
  packages: {
    "node_modules/react": { version: "18.3.1", license: "MIT" },
    "node_modules/gpl-pkg": { version: "1.2.0", license: "GPL-3.0-only" },
    "node_modules/vitest": { version: "2.1.0", license: "MIT" },
    "node_modules/mystery": { version: "0.1.0" },
  },
});

describe("licenseReport", () => {
  it("reports direct dependencies from the lockfile when it can", () => {
    const report = licenseReport(MANIFEST, LOCK);
    expect(report.manifestFound).toBe(true);
    const react = report.dependencies.find((d) => d.name === "react");
    expect(react).toMatchObject({ license: "MIT", source: "lockfile", version: "18.3.1", flag: "ok" });
  });

  it("flags restricted licenses and unknown ones", () => {
    const report = licenseReport(MANIFEST, LOCK);
    expect(report.flagged).toContain("gpl-pkg: GPL-3.0-only (restricted family)");
  });

  it("keeps devDependencies out of the flagged list", () => {
    const report = licenseReport(MANIFEST, LOCK);
    expect(report.devDependencies).toHaveLength(1);
    expect(report.flagged.join("\n")).not.toContain("vitest");
  });

  it("reports unknown (not a guess) when there is no lockfile", () => {
    const report = licenseReport(MANIFEST, null);
    const react = report.dependencies.find((d) => d.name === "react");
    // The project's own `license: MIT` says nothing about react's license —
    // the honest answer is unknown.
    expect(react).toMatchObject({ license: "unknown", source: "unknown", flag: "unknown" });
  });

  it("reports nothing when the workspace has no manifests", () => {
    const report = licenseReport(null, null);
    expect(report.manifestFound).toBe(false);
    expect(report.dependencies).toEqual([]);
    expect(report.note).toMatch(/not an audit/i);
  });

  it("survives malformed JSON in either file", () => {
    const report = licenseReport("{broken", "{also broken");
    expect(report.manifestFound).toBe(false);
    expect(report.dependencies).toEqual([]);
  });
});
