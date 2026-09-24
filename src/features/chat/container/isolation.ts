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
// 1. `Cross-Origin-Opener-Policy: same-origin`. MEASURED, not reasoned about:
//    with `same-origin-allow-popups` the browser reports
//    `crossOriginIsolated === false` and `SharedArrayBuffer` is undefined, so the
//    runtime cannot boot at all — the value looks like the one that keeps OAuth
//    popups working while isolating, and it is not. MDN says the same outright
//    (features that depend on cross-origin isolation "need to set the COOP header
//    to same-origin"), and StackBlitz's own engineering blog is blunter:
//    "Interactions that require cross-origin window interactions such as OAuth
//    and payments will break."
//
//    So this value has a PRICE, and it is paid in `github-auth.ts`: `same-origin`
//    puts a cross-origin popup in its own browsing context group, which means
//    `window.opener` is null inside it AND `.closed` on the opener's handle reads
//    true forever. Both facts are load-bearing there — the token comes back over a
//    BroadcastChannel instead of `opener.postMessage`, and a closed popup can no
//    longer be read as "the user cancelled". Change this header and read that file.
//
// 2. `Cross-Origin-Embedder-Policy: require-corp`. This is the vendor's stated
//    requirement, and the reason is not about our subresources at all: the
//    runtime is a cross-origin frame that is itself isolated, and WebContainers'
//    own troubleshooting guide says that to embed a cross-origin-isolated site
//    "both the embed and embedder have the same COOP/COEP settings. The
//    WebContainer API requires require-corp." The frame's response confirms it —
//    `https://stackblitz.com/headless` serves `COEP: require-corp`, `COOP:
//    same-origin`.
//
//    The first version of this file chose `credentialless` to avoid CORP demands
//    on `no-cors` subresources, and the fear was overblown in both directions.
//    Measured: `avatars.githubusercontent.com` and the JS CDNs send
//    `Cross-Origin-Resource-Policy: cross-origin` (the app's remote images are
//    safe), and `esm.sh` — which does not — is only ever loaded as an ES MODULE,
//    which is a CORS request, so CORP never applies to it. Both values were also
//    tried against the live boot and behave identically, so nothing is lost by
//    following the vendor's requirement instead of our own reasoning.
//
//    Since this is the value the BOOT has to be told as well, it is exported as
//    `declaredCoep()` below rather than sniffed from the document at runtime:
//    `document.crossOriginEmbedderPolicy` is not implemented in Chromium, so the
//    original sniff fell back to a hardcoded value and could disagree with the
//    header — which the runtime reports as
//    "SharedArrayBuffer transfer requires self.crossOriginIsolated" from inside
//    its own frame, with nothing pointing at the header.
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
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  {
    key: "Permissions-Policy",
    value: `camera=(), microphone=(), geolocation=(), payment=(), cross-origin-isolated=(self "${RUNTIME_ORIGIN}")`,
  },
];

/**
 * The COEP value this app SERVES.
 *
 * The boot has to be told the same value the response carries — the SDK fixes it
 * at the first boot and a mismatch is not reported as a mismatch, it surfaces as
 * "SharedArrayBuffer transfer requires self.crossOriginIsolated" from inside the
 * runtime frame.
 *
 * So it is read from the headers above rather than sniffed. Sniffing was the
 * original mistake: `document.crossOriginEmbedderPolicy` is not implemented in
 * Chromium, so "read it from the document, it reflects reality" silently fell back
 * to the wrong value on the one browser that can host a workspace.
 */
export function declaredCoep(): "require-corp" | "credentialless" {
  const value = isolationHeaderValue("cross-origin-embedder-policy");
  return value === "credentialless" ? "credentialless" : "require-corp";
}

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
 *
 * There is a FOURTH copy of this policy: the `<meta http-equiv>` in `index.html`,
 * which is the dev-time policy and applies in production too (browsers enforce
 * the intersection of the meta policy and the header). It is not optional and not
 * covered by importing this module — leaving the runtime origin out of it produced
 * "Refused to frame 'https://stackblitz.com/'" in the console and a boot that
 * never resolved. `deployment-headers.test.ts` now holds it to this value.
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
