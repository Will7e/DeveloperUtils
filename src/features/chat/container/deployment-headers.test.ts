// ============================================================
// Deployment Headers — Three Files That Must Agree
// ============================================================
// The browser workspace tier needs cross-origin isolation, and isolation is a
// property of the RESPONSE, not of the code. That makes it the one thing in this
// feature that a unit test cannot exercise directly and a browser test can only
// catch after a deploy — which is exactly the shape of a mistake that ships.
//
// Three files have to agree, and only one of them can import the shared module:
//
//   • src/features/chat/container/isolation.ts  — the source of truth
//   • vite.config.ts                            — imports it (dev + preview)
//   • vercel.json                               — JSON, cannot import anything
//   • public/_headers                           — plain text, for hosts that
//                                                 read headers from the output
//
// So this test reads the two static files and holds them to the module. It also
// asserts the CSP names the runtime origin, because a CSP that omits it produces
// a blocked iframe whose console error is about a frame, not about the workspace.
//
// The dependency check at the end is here for a different reason: the package was
// installed into `node_modules` without being declared, so a fresh clone and CI
// did not have it. That failure is invisible locally and total elsewhere, and one
// line prevents it from recurring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTENT_SECURITY_POLICY,
  ISOLATION_HEADERS,
  RUNTIME_ORIGIN,
} from "./isolation";

const ROOT = new URL("../../../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, ROOT)), "utf8");
}

interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

/** The header map served for the app's own routes */
function vercelHeaderMap(): Map<string, string> {
  const config = JSON.parse(read("vercel.json")) as VercelConfig;
  const block = config.headers.find((h) => h.source === "/(.*)");
  expect(block, "vercel.json has no `/(.*)` header block").toBeTruthy();
  return new Map(block!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

/**
 * A CSP value with a trailing semicolon removed.
 *
 * A trailing `;` is legal and means nothing, and the two static files carry one
 * while the module's join does not. Normalizing it here keeps the comparison
 * about the DIRECTIVES — which is the part that decides whether the runtime
 * frame loads — instead of about punctuation both parsers accept.
 */
function normalizedCsp(value: string | undefined): string {
  return (value ?? "").trim().replace(/;+$/, "");
}

/** The header map from a static `_headers` file (`Indented-Key: value`) */
function staticHeaderMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of read("public/_headers").split("\n")) {
    const match = /^\s+([A-Za-z][A-Za-z-]*):\s*(.+?)\s*$/.exec(line);
    if (match) map.set(match[1]!.toLowerCase(), match[2]!);
  }
  return map;
}

describe("deployment headers — the isolation contract", () => {
  it("serves every isolation header from vercel.json, with the module's exact values", () => {
    const served = vercelHeaderMap();
    for (const header of ISOLATION_HEADERS) {
      expect(served.get(header.key.toLowerCase()), `vercel.json: ${header.key}`).toBe(header.value);
    }
  });

  it("keeps the popup opener alive, because GitHub sign-in returns through it", () => {
    // Stated as its own assertion because the tempting edit is `same-origin`,
    // which isolates just as well and silently breaks sign-in instead.
    expect(vercelHeaderMap().get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  });

  it("uses credentialless, which is the COEP value the rest of the app survives", () => {
    // `require-corp` would demand Cross-Origin-Resource-Policy on every no-cors
    // subresource: esm.sh does not send it, and `img-src https:` deliberately
    // allows images from hosts that never will.
    expect(vercelHeaderMap().get("cross-origin-embedder-policy")).toBe("credentialless");
  });

  it("grants the runtime iframe the delegated cross-origin-isolated permission", () => {
    const policy = vercelHeaderMap().get("permissions-policy") ?? "";
    expect(policy).toContain(`cross-origin-isolated=(self "${RUNTIME_ORIGIN}")`);
    // The other directives are pre-existing hardening; losing them here would
    // be a quiet regression while adding one.
    for (const directive of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
      expect(policy).toContain(directive);
    }
  });

  it("serves exactly the CSP the module defines, runtime frame included", () => {
    const csp = vercelHeaderMap().get("content-security-policy");
    expect(normalizedCsp(csp)).toBe(CONTENT_SECURITY_POLICY);
    // Named separately so a failure says WHY rather than showing two long strings.
    const frameSrc = csp?.split("; ").find((d) => d.startsWith("frame-src")) ?? "";
    expect(frameSrc).toContain(RUNTIME_ORIGIN);
  });

  it("serves the same headers from the build output for hosts that read _headers", () => {
    const served = staticHeaderMap();
    for (const header of ISOLATION_HEADERS) {
      expect(served.get(header.key.toLowerCase()), `public/_headers: ${header.key}`).toBe(header.value);
    }
    expect(normalizedCsp(served.get("content-security-policy"))).toBe(CONTENT_SECURITY_POLICY);
  });

  it("has the workspace dependency declared, not merely installed", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
    };
    // A local install with no manifest entry passes every check on the machine
    // that has the directory and fails on every other one.
    expect(pkg.dependencies?.["@webcontainer/api"]).toBeTruthy();
  });
});
