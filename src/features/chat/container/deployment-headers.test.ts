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
  PREVIEW_ORIGIN,
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

/** `directive → sources`, for comparing two policies by what they ALLOW */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...values] = words;
    if (!name) continue;
    out.set(name.toLowerCase(), values);
  }
  return out;
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

  it("uses the COOP value that actually isolates, which is only `same-origin`", () => {
    // This assertion used to demand `same-origin-allow-popups`, on the reasoning
    // that both isolate and only one keeps the OAuth opener alive. Measured in a
    // browser: `same-origin-allow-popups` leaves `crossOriginIsolated === false`
    // and `SharedArrayBuffer` undefined, so the runtime cannot boot at all — the
    // test was defending a value that made the tier impossible, and it is the
    // reason a green suite shipped a workspace that could never start.
    expect(vercelHeaderMap().get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("uses the COEP value the runtime's own frame requires, which is require-corp", () => {
    // This assertion used to demand `credentialless` — chosen to spare `no-cors`
    // subresources a CORP requirement — and that reasoning was wrong twice over:
    // the runtime is itself a cross-origin isolated frame whose response serves
    // `COEP: require-corp`, and WebContainers' troubleshooting guide says embedding
    // it means "both the embed and embedder have the same COOP/COEP settings".
    // Measured: the CDNs and the GitHub avatar host send CORP anyway, and esm.sh -
    // the one that does not — is only ever loaded as an ES module, which is a CORS
    // request, so CORP never applies to it.
    expect(vercelHeaderMap().get("cross-origin-embedder-policy")).toBe("require-corp");
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

  it("allows the WebContainer server origins the preview iframe actually loads", () => {
    // The failure this pins: the workspace booted, `server-ready` fired, and the
    // preview showed Chromium's "This content is blocked" — a frame-src refusal,
    // because the dev server's URL lives on a host family no policy copy named.
    // BOTH families are required: they are different registrable domains, so one
    // wildcard cannot cover the other — serving the classic *.webcontainer.io
    // while the runtime hands out *.local-corp.webcontainer-api.io is precisely
    // the bug that got past a policy naming only one. Both directives: child-src
    // is the fallback some engines reach frame-src through.
    for (const directive of ["frame-src", "child-src"]) {
      const sources =
        CONTENT_SECURITY_POLICY.split("; ")
          .find((d) => d.startsWith(`${directive} `))
          ?.split(" ") ?? [];
      for (const origin of PREVIEW_ORIGIN.split(" ")) {
        expect(sources, `${directive} → ${origin}`).toContain(origin);
      }
    }
  });

  it("serves the same headers from the build output for hosts that read _headers", () => {
    const served = staticHeaderMap();
    for (const header of ISOLATION_HEADERS) {
      expect(served.get(header.key.toLowerCase()), `public/_headers: ${header.key}`).toBe(header.value);
    }
    expect(normalizedCsp(served.get("content-security-policy"))).toBe(CONTENT_SECURITY_POLICY);
  });

  it("keeps index.html's meta policy covering everything the deployment policy requires", () => {
    // The fourth copy, and the one that broke the boot: a `<meta http-equiv>` CSP
    // applies to the dev server AND to production (browsers enforce the
    // intersection with the header), so a runtime origin missing there blocks the
    // iframe no matter what vercel.json says. Nothing pinned it, so the fix in the
    // other three files looked complete while the frame was still refused.
    const html = read("index.html");
    const meta = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/i.exec(html);
    expect(meta, "index.html has no CSP meta tag").toBeTruthy();

    const required = directives(CONTENT_SECURITY_POLICY);
    const served = directives(meta![1]!);
    const missing: string[] = [];
    for (const [name, values] of required) {
      // Ignored by browsers in a meta policy, and absent from one by design.
      if (name === "frame-ancestors") continue;
      const present = served.get(name);
      if (!present) {
        missing.push(`${name} (the whole directive)`);
        continue;
      }
      // Superset, not equality: the meta policy is the dev policy and keeps
      // `'unsafe-inline'` in script-src for Vite's HMR preamble.
      for (const value of values) {
        if (!present.includes(value)) missing.push(`${name} → ${value}`);
      }
    }
    expect(missing, `index.html's CSP does not cover: ${missing.join(", ")}`).toEqual([]);
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
