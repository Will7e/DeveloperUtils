// ============================================================
// Isolation Contract — The Headers A Browser Workspace Requires
// ============================================================
// A browser workspace is not a library you import. It is a Node.js runtime that
// arrives in a hidden cross-origin iframe and needs `SharedArrayBuffer`, which
// browsers hand out only to a document that is CROSS-ORIGIN ISOLATED. So none of
// this tier works until three response headers are right — and "right" means
// right in every environment, because the failure mode of a missing one is a
// boot error that mentions nothing about headers.
//
// This module is the single source of truth for those headers. The Vite config
// imports it, so the dev server and the deployment cannot drift syntactically;
// `deployment-headers.test.ts` pins `vercel.json` (which cannot import
// TypeScript) to the same values, because a workspace that boots in production
// and fails on localhost — or the reverse — is the most expensive way to learn
// that two files disagree.
//
// ── The four decisions, and why ──────────────────────────────
//
// 1. `Cross-Origin-Opener-Policy: same-origin-allow-popups`, never the plain
//    `same-origin`. Both isolate the document, and only one of them survives
//    GitHub sign-in: the app authenticates through a POPUP whose result arrives
//    by `postMessage` to the opener, and `same-origin` severs that relationship
//    the moment the popup navigates. `allow-popups` keeps the opener for windows
//    the page opened itself while still isolating the document, which is exactly
//    the trade this app needs.
//
// 2. `Cross-Origin-Embedder-Policy: credentialless`, not `require-corp`. Under
//    `require-corp` every `no-cors` subresource must carry
//    `Cross-Origin-Resource-Policy`. Measured, not assumed: jsdelivr and
//    fonts.gstatic.com send it, `esm.sh` does not, and this app's `img-src`
//    deliberately allows arbitrary `https:` images — hosts nobody can
//    retroactively stamp with CORP. `credentialless` fetches those subresources
//    WITHOUT credentials instead of refusing them, so the workspace tier can be
//    added without dismantling unrelated features. The cost is real and named
//    rather than hidden: Firefox does not implement `credentialless`, so a
//    Firefox user gets "this needs a Chromium browser" from the probe instead of
//    a mysterious failure.
//
// 3. `Permissions-Policy: cross-origin-isolated=(self "<runtime origin>")`. The
//    SDK creates the runtime iframe with `allow="cross-origin-isolated"`, and a
//    delegated permission that is not granted is simply absent — the iframe ends
//    up non-isolated inside an isolated page, which is the worst of both.
//
// 4. The CSP must name the runtime origin in `frame-src`/`child-src`. The
//    runtime's own workers live inside its iframe and inherit ITS policy, so
//    `worker-src` and `script-src` here stay untouched. `WEBCONTAINER_API_IFRAME_URL`
//    can override the origin at build time; if you ever set it, change the
//    constant below in the same commit or the CSP will forbid the frame.
//
// Pure data. No DOM, so this can be imported by the Vite config and by the
// node-side type check alike.

/** Where the runtime iframe is loaded from (the SDK's own default) */
export const RUNTIME_ORIGIN = "https://stackblitz.com";

/** The runtime iframe's URL, for error messages that should be actionable */
export const RUNTIME_PATH = "/headless";

/**
 * The header set that makes a page cross-origin isolated AND keeps the rest of
 * this app working: the GitHub popup, the snippet sandbox's `esm.sh` modules,
 * and images from hosts that never heard of CORP.
 */
export const ISOLATION_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
  {
    key: "Permissions-Policy",
    value: `camera=(), microphone=(), geolocation=(), payment=(), cross-origin-isolated=(self "${RUNTIME_ORIGIN}")`,
  },
];

/** The same headers as a plain object, the shape Vite's dev server wants */
export function isolationHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of ISOLATION_HEADERS) out[header.key] = header.value;
  return out;
}

/**
 * The deployment's Content-Security-Policy.
 *
 * Unchanged from what production already serves except for the runtime frame:
 * the previous `frame-src 'self' blob: https://cdn.jsdelivr.net` forbids the one
 * URL the workspace cannot boot without.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net https://esm.sh blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://esm.sh",
  "connect-src *",
  "img-src 'self' data: blob: https:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  `child-src 'self' blob: https://cdn.jsdelivr.net ${RUNTIME_ORIGIN}`,
  `frame-src 'self' blob: https://cdn.jsdelivr.net ${RUNTIME_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Header value for one of the isolation headers, by key ("" when absent) */
export function isolationHeaderValue(key: string): string {
  return ISOLATION_HEADERS.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value ?? "";
}
