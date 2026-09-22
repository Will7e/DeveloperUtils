// ============================================================
// Preview Runtime — esbuild-wasm Bundler for the Workspace
// ============================================================
// Turns the agent workspace into a runnable single-page bundle:
//   • Detects the entry (index.html script src → src/main.tsx →
//     main.tsx/index.tsx/index.ts/index.js heuristics)
//   • Bundles TS/TSX/JS/JSX/CSS with esbuild-wasm (vendored,
//     lazy-loaded on first use, code-split by Vite)
//   • Emits a self-contained HTML document (blob URL) that mounts
//     the bundle; workspace CSS is injected; console/bridge is
//     preloaded so errors reach the agent feedback loop
//   • Static HTML entries skip the bundler entirely: relative
//     links/scripts/images are rewritten to blob URLs
//
// Workspace files resolve through a virtual FS esbuild plugin.
// Bare imports (react, lodash…) cannot be resolved in the browser
// without npm — diagnostics tell the agent to vendor dependencies
// or use an import map entry. React is shimmed via esm.sh CDN
// import maps so common repos work out of the box.

import * as esbuild from "esbuild-wasm";
import { useChatStore } from "@/stores/chat.store";
import type { WorkspaceState } from "../types";
import { PREVIEW_REBUILD_DEBOUNCE_MS } from "../constants";
import { usePreviewStore, type PreviewDiagnostic } from "./preview.store";
import { createWorkspaceVfs, type VFS } from "./vfs";
import { preloadForPreview, preloadSeeds } from "./preload";

let initialized = false;
let initPromise: Promise<void> | null = null;

/** Loads + initializes esbuild-wasm once (wasm served same-origin) */
async function ensureEsbuild(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await esbuild.initialize({
      wasmURL: `${import.meta.env.BASE_URL ?? "/"}esbuild/esbuild.wasm`,
      worker: true,
    });
    initialized = true;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

// ── Entry detection ──────────────────────────────────────────

const HTML_ENTRIES = ["index.html", "public/index.html", "preview.html"];
const JS_ENTRIES = ["src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx", "main.tsx", "index.tsx", "main.jsx", "index.jsx", "src/main.ts", "src/index.ts", "main.ts", "index.ts", "src/main.js", "src/index.js", "main.js", "index.js"];

export type EntryKind = "html" | "js";

export interface DetectedEntry {
  kind: EntryKind;
  path: string;
  /** For HTML entries: the script src it references (if any) */
  scriptSrc?: string;
}

export function detectEntry(ws: WorkspaceState): DetectedEntry | null {
  const paths = new Set(ws.tree.map((e) => e.path));
  const has = (p: string) => paths.has(p) || ws.files[p] !== undefined;

  for (const html of HTML_ENTRIES) {
    if (has(html)) {
      const content = ws.files[html]?.content ?? "";
      const m = content.match(/<script[^>]+src=["']([^"']+)["']/i);
      return { kind: "html", path: html, scriptSrc: m?.[1] };
    }
  }
  for (const js of JS_ENTRIES) {
    if (has(js)) return { kind: "js", path: js };
  }
  return null;
}

// ── Virtual FS plugin ────────────────────────────────────────
// Path resolution lives in ./vfs (shared with the preloader).

const VFS_PLUGIN_NAME = "intab-workspace-vfs";

function vfsPlugin(vfs: VFS): esbuild.Plugin {
  return {
    name: VFS_PLUGIN_NAME,
    setup(build) {
      // Resolve relative + absolute paths against the workspace
      build.onResolve({ filter: /^[./]/ }, (args) => {
        const resolved = vfs.resolveRel(args.importer ?? "", args.path);
        if (resolved) return { path: resolved, namespace: "vfs" };
        return { path: args.path, external: true }; // leave unresolvable as external
      });

      // Bare imports: externalize — the import map handles react via esm.sh.
      // Entry points must resolve INTO the vfs (they are bare paths like src/main.tsx).
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === "entry-point" || vfs.exists(args.path)) {
          return { path: args.path, namespace: "vfs" };
        }
        return { path: args.path, external: true };
      });

      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
        const content = vfs.read(args.path);
        if (content === null) {
          return {
            errors: [{ text: `File not loaded in the workspace: ${args.path}` }],
          };
        }
        const ext = args.path.split(".").pop()?.toLowerCase() ?? "";
        const loader: esbuild.Loader =
          ext === "tsx"
            ? "tsx"
            : ext === "ts"
              ? "ts"
              : ext === "jsx"
                ? "jsx"
                : ext === "css"
                  ? "css"
                  : ext === "json"
                    ? "json"
                    : "js";
        return { contents: content, loader, resolveDir: args.path.split("/").slice(0, -1).join("/") || "." };
      });
    },
  };
}

// ── Build orchestration ──────────────────────────────────────

export interface BuildOutcome {
  status: "ready" | "error";
  url: string | null;
  entry: string | null;
  diagnostics: PreviewDiagnostic[];
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let lastBuildWs: WorkspaceState | null = null;
let lastBuildResult: BuildOutcome | null = null;
let inFlight = false;
let pendingAfterCurrent = false;

/** Debounced rebuild entry point (called on workspace mutations) */
export function schedulePreviewBuild(ws: WorkspaceState): void {
  lastBuildWs = ws;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void runPreviewBuild(ws);
  }, PREVIEW_REBUILD_DEBOUNCE_MS);
}

/**
 * Fetches the files a build will need (entry + transitive local
 * imports) into the workspace. Without this the bundler fails on any
 * repo the conversation has not already read file by file.
 *
 * Fetched files are published to the chat store so the file tree,
 * read_file, and the next build all see them.
 */
async function preloadForBuild(
  ws: WorkspaceState
): Promise<WorkspaceState> {
  const token = useChatStore.getState().settings.github.token;
  if (!token) return ws;
  const seeds = preloadSeeds(detectEntry(ws));
  if (seeds.length === 0) return ws;

  const outcome = await preloadForPreview(ws, seeds, token);
  if (outcome.loaded.length === 0) return ws;

  useChatStore.getState().setWorkspace(ws.conversationId, outcome.ws);
  return outcome.ws;
}

/** Immediate build (used on pane open) */
export async function runPreviewBuild(ws: WorkspaceState): Promise<BuildOutcome> {
  const store = usePreviewStore.getState();
  if (inFlight) {
    pendingAfterCurrent = true;
    return lastBuildResult ?? { status: "error", url: null, entry: null, diagnostics: [] };
  }
  inFlight = true;
  store.setStatus("building");

  try {
    await ensureEsbuild();
    const loaded = await preloadForBuild(ws);
    const outcome = await buildWorkspace(loaded);
    lastBuildResult = outcome;
    usePreviewStore.getState().setBuild({
      url: outcome.url,
      entry: outcome.entry,
      diagnostics: outcome.diagnostics,
      status: outcome.status,
    });
    return outcome;
  } catch (err) {
    const diagnostics: PreviewDiagnostic[] = [
      {
        message: err instanceof Error ? err.message : "Preview build failed unexpectedly.",
        severity: "error",
      },
    ];
    lastBuildResult = { status: "error", url: null, entry: null, diagnostics };
    usePreviewStore.getState().setBuild({ url: null, entry: null, diagnostics, status: "error" });
    return lastBuildResult;
  } finally {
    inFlight = false;
    if (pendingAfterCurrent && lastBuildWs) {
      pendingAfterCurrent = false;
      void runPreviewBuild(lastBuildWs);
    }
  }
}

/** Best-effort capability probe — called before the first build */
export function isPreviewSupported(): boolean {
  return typeof WebAssembly !== "undefined";
}

async function buildWorkspace(ws: WorkspaceState): Promise<BuildOutcome> {
  const entry = detectEntry(ws);
  if (!entry) {
    return {
      status: "error",
      url: null,
      entry: null,
      diagnostics: [
        {
          message:
            "No preview entry found. Expected index.html, src/main.tsx, or main.tsx/index.tsx in the repository.",
          severity: "error",
        },
      ],
    };
  }

  const vfs = createWorkspaceVfs(ws);

  if (entry.kind === "html" && !entry.scriptSrc) {
    // Pure static HTML — rewrite relative assets to blob URLs
    return buildStaticHtml(ws, entry.path);
  }

  // ── Bundled path: HTML+script or standalone JS/TS entry ──
  const jsEntry = entry.kind === "js" ? entry.path : (entry.scriptSrc ?? "src/main.tsx");

  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [jsEntry],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2020",
      jsx: "automatic",
      jsxImportSource: "react",
      outdir: "/out",
      loader: { ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [vfsPlugin(vfs)],
      logLevel: "silent",
    });
  } catch (err) {
    const diagnostics = esbuildErrorsToDiagnostics(err);
    return { status: "error", url: null, entry: jsEntry, diagnostics };
  }

  const errors = (result.errors ?? []).map((e) => esbuildMessage(e));
  if (errors.length > 0) {
    return { status: "error", url: null, entry: jsEntry, diagnostics: errors };
  }

  // Collect the JS bundle + any CSS output
  let js = "";
  const cssParts: string[] = [];
  for (const file of result.outputFiles ?? []) {
    if (file.path.endsWith(".js")) js += file.text;
    if (file.path.endsWith(".css")) cssParts.push(file.text);
  }

  const html = composeEntryHtml(js, cssParts.join("\n\n"));
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  return { status: "ready", url, entry: jsEntry, diagnostics: [] };
}

/** Static HTML path: rewrite src/href references to blob URLs */
async function buildStaticHtml(ws: WorkspaceState, htmlPath: string): Promise<BuildOutcome> {
  const raw = ws.files[htmlPath]?.content ?? "";
  const vfs = createWorkspaceVfs(ws);
  const blobUrls = new Map<string, string>();

  // Inline local scripts + stylesheets as blobs
  const rewritten = await rewriteAssets(raw, htmlPath, async (ref) => {
    if (blobUrls.has(ref)) return blobUrls.get(ref)!;
    const resolved = vfs.resolveRel(htmlPath, ref);
    if (!resolved) return null;
    const content = vfs.read(resolved);
    if (content === null) return null;
    const type = ref.endsWith(".css") ? "text/css" : "text/javascript";
    const url = URL.createObjectURL(new Blob([content], { type }));
    blobUrls.set(ref, url);
    return url;
  });

  const html = composeEntryHtml("", "", rewritten);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  return { status: "ready", url, entry: htmlPath, diagnostics: [] };
}

/** Replaces relative src=/href= refs with blob URLs (async rewriter) */
async function rewriteAssets(
  html: string,
  basePath: string,
  resolve: (ref: string) => Promise<string | null>
): Promise<string> {
  const attrRe = /\s(src|href)=(["'])([^"']+)\2/gi;
  const matches: Array<{ full: string; attr: string; ref: string; quote: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    const ref = m[3]!;
    if (/^(https?:|data:|blob:|#|\/\/)/i.test(ref)) continue;
    matches.push({ full: m[0], attr: m[1]!, ref, quote: m[2]! });
  }
  let out = html;
  for (const match of matches) {
    const url = await resolve(match.ref);
    if (url) {
      out = out.replace(match.full, ` ${match.attr}=${match.quote}${url}${match.quote}`);
    }
  }
  void basePath;
  return out;
}

/** Wraps the bundle in a host HTML doc with bridge + import map */
function composeEntryHtml(js: string, css: string, staticHtml?: string): string {
  const importMap = {
    imports: {
      react: "https://esm.sh/react@19.2.0",
      "react/": "https://esm.sh/react@19.2.0/",
      "react-dom": "https://esm.sh/react-dom@19.2.0",
      "react-dom/": "https://esm.sh/react-dom@19.2.0/",
      "react-dom/client": "https://esm.sh/react-dom@19.2.0/client",
      "react/jsx-runtime": "https://esm.sh/react@19.2.0/jsx-runtime",
      "react/jsx-dev-runtime": "https://esm.sh/react@19.2.0/jsx-dev-runtime",
    },
  };

  const bridge = `<script>(${bridgeSource.toString()})();</script>`;

  if (staticHtml !== undefined) {
    // Inject bridge + import map into the static document
    const head = `<head><script type="importmap">${JSON.stringify(importMap)}</script>${bridge}`;
    const withHead = staticHtml.includes("<head>")
      ? staticHtml.replace("<head>", head)
      : `${head}</head>${staticHtml}`;
    return withHead;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
<style>${css}</style>
${bridge}
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
</body>
</html>`;
}

/** Console/error capture + execution bridge — serialized into the iframe doc */
function bridgeSource(): void {
  const post = (level: string, text: string) => {
    try {
      // "*" is required: this document is blob-backed and sandboxed, so it has
      // an opaque origin that cannot be named. The parent verifies that the
      // sender is its own preview frame.
      parent.postMessage({ source: "intab-preview", level, text }, "*");
    } catch {
      /* parent gone */
    }
  };
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2);
        } catch {
          return String(a);
        }
      })
      .join(" ");

  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      post(level, fmt(args));
      original(...args);
    };
  }
  window.addEventListener("error", (e) => {
    post("error", `${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason);
    post("error", `Unhandled rejection: ${reason}`);
  });

  // ── Agent execution requests (run_js / query_dom) ──
  // The parent posts {source, reqId, kind, ...}; this sandbox is the
  // execution world for the agent's verify loop. Results are JSON-
  // serialized with hard size caps; everything is best-effort.
  const RESULT_MAX_CHARS = 8_000;
  const DOM_MAX_MATCHES = 12;
  const DOM_SNIPPET_MAX = 1_500;

  const serialize = (value: unknown): { text: string; truncated: boolean } => {
    let seen = 0;
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return String(v);
      if (typeof v === "function") return "[function]";
      if (v instanceof Element) return `<${v.tagName.toLowerCase()}${v.id ? "#" + v.id : ""}>`;
      if (typeof v === "object" && v !== null) {
        seen++;
        if (seen > 500) return "[depth-limit]";
      }
      return v;
    });
    if (json === undefined) return { text: "undefined", truncated: false };
    if (json.length > RESULT_MAX_CHARS) {
      return { text: json.slice(0, RESULT_MAX_CHARS) + `…[truncated ${json.length - RESULT_MAX_CHARS} chars]`, truncated: true };
    }
    return { text: json, truncated: false };
  };

  const runJs = async (code: string): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    try {
      // Expression first (final value returned); statements fallback.
      let fn: (arg0: unknown) => unknown;
      try {
        fn = new Function(`"use strict"; return (async () => (${code}))();`) as (arg0: unknown) => unknown;
        return { ok: true, result: serialize(await fn(undefined)) };
      } catch (syntaxErr) {
        if (!(syntaxErr instanceof SyntaxError)) throw syntaxErr;
        fn = new Function(`"use strict"; return (async () => {\n${code}\n})();`) as (arg0: unknown) => unknown;
        return { ok: true, result: serialize(await fn(undefined)) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  };

  const queryDom = (selector: string, mode: string): { ok: boolean; result?: unknown; error?: string } => {
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      const snippets: string[] = [];
      let total = 0;
      let truncated = false;
      for (const node of nodes.slice(0, DOM_MAX_MATCHES)) {
        const snippet = mode === "text" ? (node.textContent ?? "").trim() : node.outerHTML;
        const capped = snippet.length > DOM_SNIPPET_MAX
          ? snippet.slice(0, DOM_SNIPPET_MAX) + "…[truncated]"
          : snippet;
        total += capped.length;
        if (total > RESULT_MAX_CHARS) {
          truncated = true;
          break;
        }
        snippets.push(capped);
      }
      return {
        ok: true,
        result: {
          selector,
          count: nodes.length,
          shown: snippets.length,
          truncated,
          snippets,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /**
   * Collects a geometry map of the document (or one subtree).
   *
   * Two passes on purpose: measuring rects is cheap, but
   * getComputedStyle is not, so candidates are measured first, ranked by
   * area, and only the reported slice gets its computed style read. The
   * scan itself is capped so a 5,000-node page cannot block the preview.
   *
   * What it returns is deliberately dumb: raw boxes with a few cheap
   * overflow numbers. The ANALYSIS lives in the parent
   * (lib/preview-layout.ts), where it is unit-tested and can change
   * without rebundling the preview.
   */
  const LAYOUT_SCAN_MAX = 600;
  const LAYOUT_TEXT_MAX = 40;

  const collectLayout = (selector: string | undefined, maxElements: number): { ok: boolean; result?: unknown; error?: string } => {
    try {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) return { ok: false, error: `No element matches '${selector}'.` };
      const isBody = root === document.body;
      const nodes = [
        ...(isBody ? [] : [root]),
        ...Array.from(root.querySelectorAll("*")),
      ].slice(0, LAYOUT_SCAN_MAX);

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      interface Candidate { el: Element; x: number; y: number; w: number; h: number }
      const candidates: Candidate[] = [];
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        candidates.push({ el, x: r.left, y: r.top, w: r.width, h: r.height });
      }

      // Rank by area (descending) so the reported slice is the structure
      // that decides the layout, not whichever <span> came first.
      candidates.sort((a, b) => b.w * b.h - a.w * a.h);

      const kept = candidates.slice(0, Math.max(1, Math.min(80, maxElements)));
      // Restore document order within the slice: a map the model can read
      // top-to-bottom is worth more than a size-ordered one.
      kept.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

      const elements = kept.map(({ el, x, y, w, h }) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return null;
        const isLeaf = el.children.length === 0;
        const id = el.id || undefined;
        const cls = el.className && typeof el.className === "string"
          ? el.className.trim().split(/\s+/).slice(0, 2).join(" ")
          : undefined;
        const text = isLeaf ? (el.textContent ?? "").trim().slice(0, LAYOUT_TEXT_MAX) : "";
        return {
          tag: el.tagName.toLowerCase(),
          ...(id ? { id } : {}),
          ...(cls ? { cls } : {}),
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
          ...(el.scrollWidth - el.clientWidth > 1 ? { ow: el.scrollWidth - el.clientWidth } : {}),
          ...(el.scrollHeight - el.clientHeight > 1 ? { oh: el.scrollHeight - el.clientHeight } : {}),
          ...(style.position !== "static" ? { pos: style.position } : {}),
          ...(text ? { txt: text } : {}),
        };
      }).filter((e) => e !== null);

      return {
        ok: true,
        result: {
          viewport: { w: vw, h: vh },
          document: {
            w: document.documentElement.scrollWidth,
            h: document.documentElement.scrollHeight,
          },
          total: nodes.length,
          elements,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── Screenshot (visual verification) ──
  // This frame has an opaque origin, so the parent cannot reach in to
  // rasterize it: the capture happens HERE and travels back as a data URL.
  // With no dependency available, the only rasterizer is the browser's own
  // — serialize the DOM into an SVG <foreignObject>, load that as an image,
  // draw it to a canvas. That is worth its limitations, both of which the
  // caller is TOLD rather than left to guess:
  //   • web fonts and cross-origin images do not load inside an SVG image,
  //     so the picture is layout-accurate and typographically approximate;
  //   • a browser that cannot render foreignObject yields a blank canvas,
  //     which is detected below and reported as a failure — never passed
  //     off as "the page renders nothing".
  const SHOT_MAX_SIDE = 1280;
  const SHOT_MAX_CHARS = 1_400_000;
  const SHOT_SCALES = [1, 0.6, 0.35];

  const captureScreenshot = async (
    selector: string | undefined
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    try {
      const target: Element | null = selector ? document.querySelector(selector) : document.body;
      if (!target) return { ok: false, error: `No element matches '${selector}'.` };

      const rect = target.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(selector ? rect.width : window.innerWidth));
      const cssH = Math.max(1, Math.round(selector ? rect.height : window.innerHeight));
      const baseScale = Math.min(1, SHOT_MAX_SIDE / Math.max(cssW, cssH));

      const bodyStyle = window.getComputedStyle(document.body);
      // Every readable stylesheet goes into the snapshot: inline <style>
      // blocks carry the bundle's CSS, and same-origin rules are read out of
      // the CSSOM so a <link>ed sheet is captured too. Cross-origin sheets
      // cannot be read (and would not load inside the image anyway).
      const cssParts: string[] = Array.from(document.querySelectorAll("style")).map(
        (s) => s.textContent ?? ""
      );
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) cssParts.push(rule.cssText);
        } catch {
          /* cross-origin stylesheet — skipped, and the capture says so */
        }
      }
      const css = cssParts.join("\n");

      // The clone is what gets rasterized. Scripts are stripped so nothing
      // re-executes inside the image, and a body capture drops its own tag
      // so the snapshot nests legally inside the SVG.
      const clone = target.cloneNode(true) as Element;
      clone.querySelectorAll("script, link[rel=stylesheet]").forEach((n) => n.remove());
      const container = document.createElement("div");
      if (target === document.body) container.innerHTML = (clone as HTMLElement).innerHTML;
      else container.appendChild(clone);

      const wrapper = document.createElement("div");
      wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      wrapper.style.cssText = [
        `width:${cssW}px`,
        `height:${cssH}px`,
        "margin:0",
        "overflow:hidden",
        `background:${bodyStyle.backgroundColor || "#ffffff"}`,
        `color:${bodyStyle.color}`,
        `font-family:${bodyStyle.fontFamily}`,
        `font-size:${bodyStyle.fontSize}`,
      ].join(";");
      const styleEl = document.createElement("style");
      styleEl.textContent = css;
      wrapper.appendChild(styleEl);
      wrapper.appendChild(container);

      const html = new XMLSerializer().serializeToString(wrapper);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cssW}" height="${cssH}" viewBox="0 0 ${cssW} ${cssH}">` +
        `<foreignObject x="0" y="0" width="${cssW}" height="${cssH}">${html}</foreignObject></svg>`;

      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("the browser refused to decode the DOM snapshot"));
        image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { ok: false, error: "This browser provided no 2D canvas context." };

      let dataUrl = "";
      let shotW = cssW;
      let shotH = cssH;
      for (const step of SHOT_SCALES) {
        const scale = baseScale * step;
        shotW = Math.max(1, Math.round(cssW * scale));
        shotH = Math.max(1, Math.round(cssH * scale));
        canvas.width = shotW;
        canvas.height = shotH;
        ctx.fillStyle = bodyStyle.backgroundColor || "#ffffff";
        ctx.fillRect(0, 0, shotW, shotH);
        ctx.drawImage(image, 0, 0, shotW, shotH);
        try {
          dataUrl = canvas.toDataURL("image/png");
        } catch {
          return { ok: false, error: "The rendered pixels could not be read out of the canvas." };
        }
        if (dataUrl.length <= SHOT_MAX_CHARS) break;
      }
      if (dataUrl.length > SHOT_MAX_CHARS) {
        return {
          ok: false,
          error: "The page is too detailed to capture within the transport budget. Capture a selector instead of the whole viewport.",
        };
      }

      // A rasterizer without foreignObject support still produces a valid
      // one-colour image. Detect that and say so, rather than handing the
      // model a blank page and letting it describe emptiness as a bug.
      const sample = ctx.getImageData(0, 0, shotW, shotH).data;
      const colors = new Set<string>();
      for (let i = 0; i < sample.length; i += 4 * 97) {
        colors.add(`${sample[i]},${sample[i + 1]},${sample[i + 2]}`);
        if (colors.size > 4) break;
      }
      if (shotW > 40 && shotH > 40 && colors.size <= 1) {
        return {
          ok: false,
          error:
            "This browser could not rasterize the preview DOM (the capture came back blank). " +
            "Use get_preview_layout or query_preview_dom instead.",
        };
      }

      return {
        ok: true,
        result: { dataUrl, width: shotW, height: shotH, selector: selector ?? null, approximate: true },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    // Only the embedding app may drive this execution sandbox. This frame has
    // an opaque origin, so `parent` identity is the only binding available;
    // without it any other window that reached this frame could ask it to
    // evaluate code or read its DOM on the agent's behalf.
    if (event.source !== window.parent) return;
    const data = event.data as { source?: string; reqId?: number; kind?: string; code?: string; selector?: string; mode?: string; maxElements?: number } | null;
    if (!data || data.source !== "intab-preview" || typeof data.reqId !== "number") return;
    void (async () => {
      let response: { ok: boolean; result?: unknown; error?: string };
      if (data.kind === "run_js") {
        response = typeof data.code === "string" && data.code.trim()
          ? await runJs(data.code)
          : { ok: false, error: "run_js request is missing its code." };
      } else if (data.kind === "query_dom") {
        response = typeof data.selector === "string" && data.selector.trim()
          ? queryDom(data.selector, data.mode === "text" ? "text" : "html")
          : { ok: false, error: "query_dom request is missing its selector." };
      } else if (data.kind === "layout") {
        response = collectLayout(
          typeof data.selector === "string" && data.selector.trim() ? data.selector : undefined,
          typeof data.maxElements === "number" && Number.isFinite(data.maxElements) ? data.maxElements : 40
        );
      } else if (data.kind === "screenshot") {
        response = await captureScreenshot(
          typeof data.selector === "string" && data.selector.trim() ? data.selector : undefined
        );
      } else {
        response = { ok: false, error: `Unknown request kind: ${String(data.kind)}` };
      }
      try {
        parent.postMessage({ source: "intab-preview", reqId: data.reqId, ...response }, "*");
      } catch {
        /* parent gone */
      }
    })();
  });

  post("system", "preview-ready");
}

/** Normalizes esbuild failure objects into diagnostics */
function esbuildErrorsToDiagnostics(err: unknown): PreviewDiagnostic[] {
  const anyErr = err as { errors?: esbuild.Message[]; message?: string };
  if (anyErr?.errors?.length) {
    return anyErr.errors.map(esbuildMessage);
  }
  return [{ message: anyErr?.message ?? "Bundle failed.", severity: "error" }];
}

function esbuildMessage(m: esbuild.Message): PreviewDiagnostic {
  return {
    file: m.location?.file,
    line: m.location?.line,
    message: [m.text, ...(m.notes ?? []).map((n) => n.text)].filter(Boolean).join("\n"),
    severity: "error",
  };
}
