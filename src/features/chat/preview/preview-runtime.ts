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
// Workspace files resolve through a virtual FS esbuild plugin, which
// now applies PATH ALIASES (tsconfig `paths`, vite `resolve.alias`)
// before deciding a specifier is a package. Anything that really is a
// package gets an entry in an import map built from the repository's own
// package.json — see ./module-resolution. A specifier with no
// destination is reported by name instead of silently externalized,
// which is what used to produce a black frame with no diagnostic.

import * as esbuild from "esbuild-wasm";
import { useChatStore } from "@/stores/chat.store";
import type { WorkspaceState } from "../types";
import { PREVIEW_REBUILD_DEBOUNCE_MS } from "../constants";
import { usePreviewStore, type PreviewDiagnostic } from "./preview.store";
import { createWorkspaceVfs, type VFS } from "./vfs";
import { base64ToBytes, inlineReference } from "./assets";
import {
  publishPreviewDocument,
  previewHostNotice,
} from "./host/preview-host-client";
import type { PreviewDelivery } from "./preview.store";
import { readFileContent } from "../lib/github-client";
import { configSeedPaths, preloadForPreview, preloadSeeds } from "./preload";
import { composeEntryHtml } from "./document";
import { detectEntry, resolveEntryScriptPath, unsupportedProjectReason } from "./entry";
import {
  collectDeclaredVersions,
  normalizeVersion,
  parseLockfileVersions,
  parsePackageJson,
  pickLockfilePath,
} from "./module-resolution";
import { bundleWorkspace } from "./bundle";
import type { FetchedModule, GraphPorts, PackageVersions } from "./graph";
import {
  readAliasConfig,
  TSCONFIG_CANDIDATES,
  VITE_CONFIG_CANDIDATES,
  type AliasConfig,
} from "./aliases";
import { buildDefineMap, buildPreviewEnv, describeEnv } from "./env";
import { detectCssToolchain, planCss, type CssPlan } from "./css-pipeline";

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
// Moved to ./entry — pure, and testable without loading esbuild. Re-exported
// here because callers already reach for it through this module.
export { detectEntry, unsupportedProjectReason } from "./entry";
export type { DetectedEntry, EntryKind } from "./entry";

// ── Virtual FS plugin ────────────────────────────────────────
// Path resolution lives in ./vfs (shared with the preloader).

/** Asset bytes for the static-HTML path, which inlines files itself */
interface AssetInliner {
  bytes(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Assets carried as a placeholder instead of their real bytes */
  unavailable(): string[];
}

/**
 * The network a build may use, in one place.
 *
 * Two different things are fetched, from two different places: package
 * SOURCE from the module host, and asset BYTES from the attached
 * repository. Both are memoized, so a module or an image referenced from
 * twenty places is fetched once.
 *
 * `res.url` is deliberately the module's identity. esm.sh answers a
 * package URL by redirecting to its built path, and that path is the only
 * base its own relative imports mean anything against — and, because the
 * graph keys modules by it, the reason a redirect cannot produce two
 * copies of one package.
 */
function createGraphPorts(ws: WorkspaceState): GraphPorts {
  const token = useChatStore.getState().settings.github.token;
  const modules = new Map<string, FetchedModule>();
  const assets = new Map<string, string | null>();

  return {
    async fetchModule(url) {
      const cached = modules.get(url);
      if (cached) return cached;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const fetched: FetchedModule = { source: await res.text(), finalUrl: res.url || url };
      modules.set(url, fetched);
      return fetched;
    },

    async assetBase64(path) {
      const cached = assets.get(path);
      if (cached !== undefined) return cached;
      let base64: string | null = null;
      if (token) {
        try {
          const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
          // null for files over the Contents API's 1 MB limit: the bytes
          // exist on GitHub, but not in this response.
          base64 = file.base64;
        } catch {
          base64 = null;
        }
      }
      assets.set(path, base64);
      return base64;
    },
  };
}

function createAssetInliner(ws: WorkspaceState): AssetInliner {
  const ports = createGraphPorts(ws);
  const unavailable = new Set<string>();
  return {
    unavailable: () => [...unavailable],
    async bytes(path) {
      const base64 = await ports.assetBase64(path);
      if (base64 === null) {
        unavailable.add(path);
        return null;
      }
      return base64ToBytes(base64);
    },
  };
}

// ── Build orchestration ──────────────────────────────────────

export interface BuildOutcome {
  status: "ready" | "error";
  /**
   * The entry document, handed to the frame via `srcdoc`. This is what the
   * pane actually renders: a blob: URL requires the frame to NAVIGATE, and
   * some browser builds refuse blob navigation without firing a load event
   * — producing a black pane with nothing to show for it. `srcdoc` is parsed
   * in place, so the document is always the thing on screen.
   */
  html: string | null;
  /**
   * Hosted URL of the same document when a preview host served it — set
   * only for an origin the preview genuinely owns. Null means the inline
   * path, where there is nothing safe to open in a tab (see toDocument).
   */
  url: string | null;
  entry: string | null;
  diagnostics: PreviewDiagnostic[];
  /**
   * Fingerprint of the emitted JS. The pane reloads the frame only when
   * this changes — a CSS-only edit is injected into the running frame
   * instead, so the app keeps its state (and stops flashing on every write
   * of a multi-file edit).
   */
  jsHash?: string;
  /** The bundle's CSS, kept so it can be hot-swapped without a reload */
  css?: string;
  /** Which delivery path the build took, and why (see ./host/preview-host-client) */
  delivery?: PreviewDelivery;
  deliveryNotice?: string | null;
}

/**
 * Delivers a built document to the frame. One document, two paths:
 *
 *   • a preview host is listening → the document is PUBLISHED and the frame
 *     navigates to `http://127.0.0.1:<port>/p/<id>/`. That URL is a
 *     distinct origin from the app, so the preview cannot touch the app's
 *     storage — and it is a real secure origin, so localStorage, cookies,
 *     IndexedDB and Web Locks are granted by the browser instead of being
 *     emulated in memory by the document's own prelude.
 *   • no host → the inline sandboxed document, fed to the frame through
 *     `srcdoc`, which is what the runtime has always done.
 *
 * In the second case there is deliberately NO blob URL. A blob document
 * inherits the APP's origin, so the "open in new tab" link was handing the
 * previewed code — including whatever npm packages it imports — a
 * top-level page with full access to the app's localStorage. An opaque
 * sandbox is the safer of the two, so the fallback keeps the sandbox and
 * drops the link rather than the other way round.
 */
async function toDocument(html: string): Promise<{
  html: string;
  url: string | null;
  delivery: PreviewDelivery;
  deliveryNotice: string | null;
}> {
  const outcome = await publishPreviewDocument(html);
  const notice = previewHostNotice(outcome);
  if (notice) usePreviewStore.getState().addConsole([{ level: "system", text: notice }]);
  return {
    html,
    url: outcome.hosted ? outcome.hosted.url : null,
    delivery: outcome.hosted ? "hosted" : "inline",
    // The console says it once; the pane's badge carries the current reason.
    deliveryNotice: outcome.notice,
  };
}

/**
 * Cheap, stable fingerprint of a string (FNV-1a). Used only to decide
 * whether a rebuild produced different JS, so it needs to be fast and
 * deterministic rather than cryptographic.
 */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let lastBuildWs: WorkspaceState | null = null;
let lastBuildResult: BuildOutcome | null = null;
let inFlight = false;
let pendingAfterCurrent = false;
/** Fingerprint of the inputs the last SUCCESSFUL build used */
let lastBuildInputHash: string | null = null;

/**
 * Fingerprints everything a build reads, so a workspace change that does
 * not touch any file content cannot cause a reload.
 *
 * `schedulePreviewBuild` is called from every write path, and it used to
 * rebuild unconditionally. That is how a three-file edit became three
 * full frame reloads — and why state was lost each time. Comparing this
 * hash first means the debounce collapses a burst of writes into ONE
 * build, and a no-op change into none at all.
 */
function buildInputHash(ws: WorkspaceState): string {
  const parts: string[] = [];
  for (const [path, file] of Object.entries(ws.files)) {
    parts.push(`${path}\u0000${file.status}\u0000${file.content.length}`);
  }
  parts.sort();
  return hashText(`${ws.branch}\u0001${ws.baseCommitSha}\u0001${parts.join("\u0001")}`);
}

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
 * True when this workspace snapshot would produce the build that is
 * already on screen, so the caller can skip the rebuild entirely.
 */
function inputsUnchanged(ws: WorkspaceState): boolean {
  if (lastBuildInputHash === null) return false;
  if (lastBuildResult?.status !== "ready") return false;
  return buildInputHash(ws) === lastBuildInputHash;
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

  const publish = (next: WorkspaceState): WorkspaceState => {
    useChatStore.getState().setWorkspace(next.conversationId, next);
    return next;
  };

  // Pass 1 — configuration. The entry cannot be located without it
  // (vite `root`, monorepo layout), and neither can the import map, the
  // aliases, or the env defines. Fetching these first is what lets the
  // second pass know what to look for.
  let current = ws;
  const configSeeds = configSeedPaths(ws.tree.map((e) => e.path));
  if (configSeeds.length > 0) {
    const configOutcome = await preloadForPreview(current, configSeeds, token);
    if (configOutcome.loaded.length > 0) current = publish(configOutcome.ws);
  }

  // Pass 2 — the entry graph.
  const entry = detectEntry(current, { root: readAliasConfigFor(current).root });
  const seeds = preloadSeeds(entry);
  if (seeds.length === 0) return current;

  const outcome = await preloadForPreview(current, seeds, token);
  if (outcome.loaded.length === 0) return current;
  return publish(outcome.ws);
}

/**
 * Reads the alias/root configuration from the files currently loaded.
 * A single place for both the preload pass (which needs `root`) and the
 * build (which needs the rules), so the two can never disagree about
 * which files define a project's layout.
 */
function readAliasConfigFor(ws: WorkspaceState): AliasConfig {
  const configs = new Map<string, string>();
  for (const path of [...TSCONFIG_CANDIDATES, ...VITE_CONFIG_CANDIDATES]) {
    const content = ws.files[path]?.content;
    if (content !== undefined) configs.set(path, content);
  }
  return readAliasConfig({ configs, treePaths: ws.tree.map((e) => e.path) });
}

/**
 * Immediate build (used on pane open, and by the explicit rebuild button).
 *
 * `force` exists because the unchanged-inputs shortcut is for SCHEDULED
 * rebuilds, which fire on every workspace write. An explicit rebuild must
 * always build: a frame can be black while the last build reported `ready`
 * (a document that rendered nothing, a runtime error that only appears on
 * screen), and answering that click with a cached result makes the button
 * look broken — which is exactly how it was reported.
 */
export async function runPreviewBuild(
  ws: WorkspaceState,
  options: { force?: boolean } = {}
): Promise<BuildOutcome> {
  const store = usePreviewStore.getState();
  if (inFlight) {
    pendingAfterCurrent = true;
    return lastBuildResult ?? { status: "error", html: null, url: null, entry: null, diagnostics: [] };
  }
  if (!options.force && inputsUnchanged(ws)) {
    // Nothing a build reads has changed — do not tear down a running app.
    return lastBuildResult!;
  }

  inFlight = true;
  store.setStatus("building");

  try {
    await ensureEsbuild();
    const loaded = await preloadForBuild(ws);
    const outcome = await buildWorkspace(loaded);
    lastBuildResult = outcome;
    if (outcome.status === "ready") lastBuildInputHash = buildInputHash(loaded);
    usePreviewStore.getState().setBuild({
      html: outcome.html,
      url: outcome.url,
      entry: outcome.entry,
      diagnostics: outcome.diagnostics,
      status: outcome.status,
      jsHash: outcome.jsHash,
      css: outcome.css,
      delivery: outcome.delivery,
      deliveryNotice: outcome.deliveryNotice,
    });
    return outcome;
  } catch (err) {
    const diagnostics: PreviewDiagnostic[] = [
      {
        message: err instanceof Error ? err.message : "Preview build failed unexpectedly.",
        severity: "error",
      },
    ];
    lastBuildResult = { status: "error", html: null, url: null, entry: null, diagnostics };
    usePreviewStore
      .getState()
      .setBuild({ html: null, url: null, entry: null, diagnostics, status: "error" });
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

/** Reads the project configuration a build needs out of the workspace */
interface ProjectConfig {
  manifest: ReturnType<typeof parsePackageJson>;
  /** Every declared dependency's pinned version — what the graph fetches */
  versions: PackageVersions;
  aliases: AliasConfig;
  cssPlan: CssPlan;
  define: Record<string, string>;
  root: string | null;
  /** Diagnostics the configuration alone produced */
  notes: PreviewDiagnostic[];
}

function readProjectConfig(ws: WorkspaceState, vfs: VFS): ProjectConfig {
  const notes: PreviewDiagnostic[] = [];
  const content = (path: string): string | null => ws.files[path]?.content ?? null;

  // ── Dependencies → import map ──
  const manifest = parsePackageJson(content("package.json"));
  const lockfilePath = pickLockfilePath(ws.tree.map((e) => e.path));
  const lockfileVersions = lockfilePath
    ? parseLockfileVersions(content(lockfilePath))
    : {};
  // Every declared dependency, pinned to one concrete version. This table
  // is the ONLY thing that decides what the bundler fetches, so a package
  // declared here is exactly what a bare import resolves to.
  const declaredVersions = collectDeclaredVersions(manifest, lockfileVersions);
  const versions: PackageVersions = {};
  for (const [pkg, range] of Object.entries(declaredVersions)) {
    versions[pkg] = normalizeVersion(range);
  }

  const dependencyCount = Object.keys(manifest.dependencies).length;
  if (dependencyCount === 0 && ws.tree.some((e) => e.path === "package.json")) {
    notes.push({
      message:
        "package.json was read but declares no dependencies, so imported packages cannot be resolved in the preview. Check that the file was loaded and that dependencies are under `dependencies`/`devDependencies`.",
      severity: "warning",
    });
  }

  // ── Aliases and the configured root ──
  const aliases = readAliasConfigFor(ws);
  if (aliases.unparsed) {
    notes.push({
      message: `Path aliases could not be read from ${aliases.read.join(", ")} (the alias definition is computed rather than literal). Imports through an alias will not resolve in the preview.`,
      severity: "warning",
    });
  }
  const resolvedRules = aliases.rules.filter((r) => vfs.exists(r.target.replace(/\/$/, "")));
  if (aliases.rules.length > 0 && resolvedRules.length === 0) {
    notes.push({
      message: `Alias rules were read (${aliases.rules.map((r) => r.prefix).join(", ")}) but none point at a file in the workspace, so aliased imports will fall through to the package resolver.`,
      severity: "warning",
    });
  }

  // ── CSS toolchain ──
  const cssFiles: Array<{ path: string; content: string }> = [];
  for (const entry of ws.tree) {
    if (!/\.(css|scss|sass|less|styl)$/i.test(entry.path)) continue;
    const fileContent = ws.files[entry.path]?.content;
    if (fileContent !== undefined) cssFiles.push({ path: entry.path, content: fileContent });
  }
  const cssToolchain = detectCssToolchain({
    manifest,
    configPaths: ws.tree.map((e) => e.path).filter((p) => !p.includes("/")),
    cssFiles,
  });
  const cssPlan = planCss(cssToolchain);
  for (const diagnostic of cssPlan.diagnostics) {
    notes.push(diagnostic);
  }

  // ── Environment ──
  const envFiles = new Map<string, string>();
  for (const [path, file] of Object.entries(ws.files)) {
    const base = path.split("/").pop() ?? "";
    if (/^\.env(\.|$)/.test(base) && file.content !== undefined) envFiles.set(path, file.content);
  }
  const env = buildPreviewEnv({
    envFiles,
    treePaths: ws.tree.map((e) => e.path),
    baseUrl: "/",
  });
  const envNote = describeEnv(env);
  if (envNote) notes.push({ message: envNote, severity: "warning" });

  return {
    manifest,
    versions,
    aliases,
    cssPlan,
    define: buildDefineMap(env),
    root: aliases.root,
    notes,
  };
}

async function buildWorkspace(ws: WorkspaceState): Promise<BuildOutcome> {
  const vfs = createWorkspaceVfs(ws);
  const config = readProjectConfig(ws, vfs);

  const entry = detectEntry(ws, { root: config.root });
  if (!entry) {
    const unsupported = unsupportedProjectReason(ws);
    return {
      status: "error",
      html: null,
      url: null,
      entry: null,
      diagnostics: [
        {
          message:
            unsupported ??
            "No preview entry found. The preview looks for index.html (anywhere in the tree), src/main.tsx, src/index.tsx, main.tsx, index.tsx, or the equivalent .js/.ts entries — honouring a Vite `root` when one is configured.",
          severity: "error",
        },
        ...config.notes,
      ],
    };
  }

  if (entry.kind === "html" && !entry.scriptSrc) {
    // Pure static HTML — rewrite relative assets to blob URLs
    return buildStaticHtml(ws, entry.path, config);
  }

  // ── Bundled path: HTML+script or standalone JS/TS entry ──
  //
  // An HTML entry names its script as a URL (`/src/main.jsx`), which is not
  // a path until it is resolved against the document. Passing the raw
  // attribute through is how a build failed on its OWN entry point —
  // "`/src/main.jsx` is in the repository but its contents were not loaded"
  // — while the preloader had already fetched `src/main.jsx`.
  const jsEntry =
    entry.kind === "js"
      ? entry.path
      : resolveEntryScriptPath({
          htmlPath: entry.path,
          scriptSrc: entry.scriptSrc,
          exists: (path) => vfs.exists(path),
          resolveRel: (from, rel) => vfs.resolveRel(from, rel),
        });
  if (!jsEntry) {
    return {
      status: "error",
      html: null,
      url: null,
      entry: entry.scriptSrc ?? entry.path,
      diagnostics: [
        {
          message:
            `${entry.path} loads \`${entry.scriptSrc}\`, which is not a file in this repository, so there is nothing to bundle. ` +
            "A script src is resolved from the repository root first, then from the document's own directory. " +
            "Check the path — and note that a binary file, or one over GitHub's 1 MB limit, has no contents to bundle.",
          severity: "error",
        },
        ...config.notes,
      ],
    };
  }
  // The bundler resolves and FETCHES everything itself (see ./graph). A
  // specifier it cannot satisfy fails the build, naming the file and the
  // reason — instead of being left in the bundle for a browser to reject at
  // runtime, which is how an unresolvable import became a blank frame with
  // no diagnostic attached to it.
  const bundled = await bundleWorkspace({
    entry: jsEntry,
    vfs,
    aliases: config.aliases,
    versions: config.versions,
    define: config.define,
    cssPlan: config.cssPlan,
    ports: createGraphPorts(ws),
  });

  if (bundled.status === "error") {
    return {
      status: "error",
      html: null,
      url: null,
      entry: jsEntry,
      diagnostics: [...bundled.diagnostics, ...config.notes],
    };
  }
  const { js, css } = bundled;

  // The bundler already reported what it had to work around, by name:
  // unresolved imports, missing local files, dropped query suffixes,
  // stripped vendor CSS, and assets it could only placeholder.
  const diagnostics: PreviewDiagnostic[] = [...config.notes, ...bundled.diagnostics];

  // An HTML entry contributes its OWN document, because the app's markup is
  // the app: it holds the mount point the bundle looks for, the body classes
  // its styles depend on, and the meta viewport. Rendering into a generated
  // stub discarded all of that and produced a build that succeeded while
  // showing nothing (see ./document).
  const entryHtml = entry.kind === "html" ? ws.files[entry.path]?.content : undefined;
  const document = await toDocument(
    composeEntryHtml({
      js,
      css,
      scripts: config.cssPlan.scripts,
      bridge: bridgeTag(),
      staticHtml: entryHtml,
      replacedScriptSrc: entry.kind === "html" ? (entry.scriptSrc ?? null) : null,
    })
  );
  return {
    status: "ready",
    ...document,
    entry: jsEntry,
    diagnostics,
    jsHash: hashText(js),
    css,
  };
}



/** Static HTML path: rewrite src/href references to blob URLs */
async function buildStaticHtml(
  ws: WorkspaceState,
  htmlPath: string,
  config: ProjectConfig
): Promise<BuildOutcome> {
  const raw = ws.files[htmlPath]?.content ?? "";
  const vfs = createWorkspaceVfs(ws);
  const assets = createAssetInliner(ws);
  const inlined = new Map<string, string>();

  // EVERY reference the document makes is inlined as a data URL.
  //
  // It used to be a `blob:` URL per asset, created here in the APP's origin.
  // That works in a `srcdoc` frame only by accident, and it is plainly wrong
  // for a served preview: a blob URL belongs to the origin that created it,
  // so a document served from the preview's own origin CANNOT load
  // `blob:http://localhost:5173/…`. Every image, stylesheet and script in a
  // static site came back as a broken subresource — "it does not render all
  // the components of a website" — while the build reported success.
  //
  // A data URL belongs to the document that carries it, so it works on both
  // delivery paths, and the document stays self-contained.
  const rewritten = await rewriteAssets(raw, htmlPath, async (ref) => {
    const cached = inlined.get(ref);
    if (cached !== undefined) return cached;
    const resolved = vfs.resolveRel(htmlPath, ref);
    if (!resolved) return null;
    const url = await inlineReference(resolved, {
      bytes: (path) => assets.bytes(path),
      text: (path) => vfs.read(path),
    });
    if (url) inlined.set(ref, url);
    return url;
  });

  const diagnostics = [...config.notes];
  const unavailableAssets = assets.unavailable();
  if (unavailableAssets.length > 0) {
    diagnostics.push({
      message: `These assets could not be inlined, so they are missing from the preview: ${unavailableAssets.sort().join(", ")}.`,
      severity: "warning",
    });
  }

  const document = await toDocument(
    composeEntryHtml({
      js: "",
      css: "",
      scripts: config.cssPlan.scripts,
      bridge: bridgeTag(),
      staticHtml: rewritten,
      replacedScriptSrc: null,
    })
  );
  return {
    status: "ready",
    ...document,
    entry: htmlPath,
    diagnostics,
    jsHash: hashText(rewritten),
    css: "",
  };
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

/**
 * Wraps the bundle in a host HTML document with the bridge and the import
 * map.
 *
 * The import map is built from the REPOSITORY's dependencies (see
 * ./module-resolution) rather than a fixed React shim, and the runtime
 * scripts come from the CSS plan. Both are passed in so this function
 * stays a pure string composer.
 *
 * NOTE: every host these URLs name must also appear in the app's
 * `script-src` (index.html for dev, vercel.json for production). A srcdoc
 * document inherits the app's Content-Security-Policy, so a host missing
 * there is blocked and the bundle's first import never resolves — the
 * black-frame failure the CSP contract test exists to prevent.
 */
/** The bridge + capability prelude, serialized into every preview document */
function bridgeTag(): string {
  return `<script>(${bridgeSource.toString()})();</script>`;
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

  // A preview that renders nothing has to say why. A blocked module import
  // (CSP, offline CDN) is reported to the browser console as a violation, not
  // as a page error, so it never reached this bridge — which is how a
  // policy-blocked preview became a black rectangle with no explanation, in
  // the pane and in get_preview_feedback alike. The preview document INHERITS
  // the app's policy, so this is also the fastest way to see that the app's
  // CSP and the preview's needs have drifted apart.
  window.addEventListener("securitypolicyviolation", (e) => {
    post(
      "error",
      `Content-Security-Policy blocked ${e.violatedDirective}` +
        (e.blockedURI ? ` → ${e.blockedURI}` : "") +
        ". The preview document inherits this app's policy, so every host the preview loads from — and the inline scripts this document needs — must be allowed by script-src in index.html (dev) AND vercel.json (production). A deployed build whose script-src lacks 'unsafe-inline' cannot run a srcdoc preview at all."
    );
  });

  // ── Sandbox capability shims ──
  // The frame is sandboxed WITHOUT allow-same-origin, so its origin is
  // opaque. Measured in Chromium, that costs a generated app far more than
  // it looks: reading `localStorage`, `sessionStorage`, `document.cookie` and
  // `indexedDB` all THROW SecurityError, and `crypto.randomUUID` is missing
  // outright (an opaque origin is not a secure context). An app that touches
  // any of those while mounting dies before it can attach a single listener —
  // the user sees a rendered page whose every button does nothing. Shimming
  // them keeps the app running; the shims are in-memory and say so.
  const memoryStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => (map.has(String(k)) ? (map.get(String(k)) as string) : null),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      removeItem: (k: string) => {
        map.delete(String(k));
      },
      setItem: (k: string, v: string) => {
        map.set(String(k), String(v));
      },
    } as unknown as Storage;
  };

  /** True when reading `probe` throws (the opaque-origin signature) */
  const isBlocked = (probe: () => unknown): boolean => {
    try {
      void probe();
      return false;
    } catch {
      return true;
    }
  };

  const shimStorage = (prop: "localStorage" | "sessionStorage"): boolean => {
    // The ACCESS itself is what throws in a sandboxed document.
    if (!isBlocked(() => (window as unknown as Record<string, unknown>)[prop])) return false;
    try {
      Object.defineProperty(window, prop, {
        value: memoryStorage(),
        configurable: true,
        writable: false,
      });
      post("system", `${prop} is blocked in the preview sandbox — in-memory storage in use (state resets on rebuild).`);
    } catch {
      /* could not shim; the app keeps seeing the original SecurityError */
    }
    return true;
  };
  // Storage is the cheapest reliable probe for an opaque origin, and the
  // answer decides how the OTHER capability gaps are handled. Sans this, the
  // gaps get discovered one crash report at a time.
  const localBlocked = shimStorage("localStorage");
  const sessionBlocked = shimStorage("sessionStorage");
  const opaqueOrigin = localBlocked || sessionBlocked;

  // An opaque origin is not a secure context, so randomUUID (and subtle) are
  // absent instead of throwing. getRandomValues still works, which is enough
  // to build a real v4 UUID.
  try {
    const c = window.crypto as Crypto & { randomUUID?: () => string };
    if (c && typeof c.randomUUID !== "function" && typeof c.getRandomValues === "function") {
      Object.defineProperty(c, "randomUUID", {
        configurable: true,
        value: () => {
          const b = new Uint8Array(16);
          c.getRandomValues(b);
          b[6] = ((b[6] as number) & 0x0f) | 0x40;
          b[8] = ((b[8] as number) & 0x3f) | 0x80;
          const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
          return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        },
      });
      post("system", "crypto.randomUUID is unavailable in the preview sandbox — shimmed from getRandomValues.");
    }
  } catch {
    /* leave crypto as the browser provides it */
  }

  // Cookie reads/writes throw here too. A jar in memory keeps an app that
  // merely stores a banner preference from dying on its first render.
  try {
    void document.cookie;
  } catch {
    try {
      const jar = new Map<string, string>();
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: () => Array.from(jar, ([k, v]) => `${k}=${v}`).join("; "),
        set: (raw: string) => {
          const [pair, ...attrs] = String(raw).split(";");
          const eq = (pair ?? "").indexOf("=");
          if (eq <= 0) return;
          const name = (pair ?? "").slice(0, eq).trim();
          const value = (pair ?? "").slice(eq + 1).trim();
          const expired = attrs.some((a) => /max-age\s*=\s*0/i.test(a));
          if (expired) jar.delete(name);
          else jar.set(name, value);
        },
      });
      post("system", "document.cookie is blocked in the preview sandbox — in-memory cookie jar in use.");
    } catch {
      /* could not shim */
    }
  }

  // Web Locks exists in an opaque origin but DENIES every request, which is
  // worse than not having it: libraries feature-detect `navigator.locks`,
  // await `request`, and take the rejection as an unhandled one. Supabase's
  // auth-js locks while it initializes, so a previewed app with Supabase in
  // it reports "Access to the Locks API is denied in this context" and never
  // finishes starting. A preview is one document in one frame, so there is
  // no second tab to exclude: running the callback inline IS the correct
  // serialization here, not an approximation of one.
  if (opaqueOrigin) {
    try {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: async (
            name: string,
            options: unknown,
            callback?: (lock: { name: string; mode: string }) => unknown
          ) => {
            const run =
              typeof callback === "function"
                ? callback
                : typeof options === "function"
                  ? (options as (lock: { name: string; mode: string }) => unknown)
                  : null;
            if (!run) throw new TypeError(`LockManager.request: no callback (${name})`);
            // The callback is handed a LOCK, not nothing. A library that checks
            // it treats a missing lock as "this browser does not follow the
            // spec" and says so on EVERY call: supabase's auth-js logged seven
            // identical warnings per build while the lock was working exactly
            // as intended. The name and mode are the whole of the interface
            // the callback can observe.
            const mode = (options as { mode?: string } | null)?.mode ?? "exclusive";
            return await run({ name, mode });
          },
          query: async () => ({ held: [], pending: [] }),
        },
      });
      post(
        "system",
        "navigator.locks is denied in the preview sandbox — lock callbacks run inline (a single-frame preview needs no cross-tab exclusion)."
      );
    } catch {
      /* navigator is not configurable here; the app keeps seeing the SecurityError */
    }
  }

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

  /**
   * Replaces the app stylesheet in place (the `set_css` request). Only the
   * element this document owns is rewritten, so a package-managed runtime
   * stylesheet (Tailwind's browser build) is left alone.
   */
  const setAppCss = (css: string): { ok: boolean; result?: unknown; error?: string } => {
    try {
      let style = document.getElementById("intab-app-css") as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = "intab-app-css";
        document.head.appendChild(style);
      }
      style.textContent = css;
      return { ok: true, result: { bytes: css.length } };
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
    const data = event.data as { source?: string; reqId?: number; kind?: string; code?: string; selector?: string; mode?: string; maxElements?: number; css?: string } | null;
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
      } else if (data.kind === "set_css") {
        // Hot-swap the stylesheet WITHOUT reloading the frame. A rebuild
        // that only changed CSS used to remount the whole app, losing every
        // bit of state the user had built up; now the running document just
        // gets new rules.
        response = setAppCss(typeof data.css === "string" ? data.css : "");
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

  // ── Post-boot honesty check ──
  // The bundle can load and still render nothing: an unresolved module
  // specifier throws during module instantiation, which does NOT always
  // reach window.onerror, and a component that throws on its first render
  // leaves an empty root. Either way the pane used to show a blank frame
  // with no explanation — the single most common "the preview is broken"
  // report. So after the document settles, check whether anything is on
  // screen and, if not, say so in the console channel the pane and the
  // agent's feedback tool both read.
  const ROOT_CANDIDATES = ["#root", "#app", "#__next", "main", "body"];
  const reportIfEmpty = (phase: string): void => {
    try {
      const filled = ROOT_CANDIDATES.some((selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        return el.childElementCount > 0 || (el.textContent ?? "").trim().length > 0;
      });
      if (filled) return;
      post(
        "error",
        `The bundle loaded but rendered nothing (${phase}): every root element is empty. ` +
          "Usual causes: a module the frame could not instantiate, " +
          "an error thrown while the entry module initialised, or an entry file that mounts nothing."
      );
    } catch {
      /* the check itself must never break the preview */
    }
  };
  setTimeout(() => reportIfEmpty("2.5s after load"), 2_500);
  window.addEventListener("load", () => setTimeout(() => reportIfEmpty("after the load event"), 900));

  post("system", "preview-ready");
}


