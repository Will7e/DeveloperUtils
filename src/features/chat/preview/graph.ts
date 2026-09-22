// ============================================================
// Preview Graph — Workspace Files and Fetched Packages, One Graph
// ============================================================
// The rewrite's core. Two inputs become one module graph:
//
//   • the agent's workspace (text files, and assets carried as bytes)
//   • package source FETCHED from the module host during the build
//
// ...and one output: a bundle with no external references left in it.
//
// The decision that made the previous preview fragile is inverted here. It
// left `import "react"` in the bundle and let the BROWSER resolve it
// against an import map, so every failure of that resolution — a prefix
// rule violated, a package mapped to nothing, a second copy of React
// arriving from a package esm.sh had bundled one into — surfaced at
// runtime, in a frame, as an uncaught error with no build diagnostic
// attached. This layer resolves EVERY specifier itself, at build time, and
// a specifier it cannot resolve becomes a build error with the file and
// the reason.
//
// Structure worth knowing:
//   • `planRequest` is the whole resolution policy, pure and testable
//     without esbuild. The plugin below is a thin adapter over it.
//   • A remote module's PATH is its URL, and that is the dedupe key.
//     Two importers naming `react` produce one URL, so one module.
//   • `ports` inject the network. The tests supply a fake module host and
//     bundle for real, which is how "exactly one React" is provable
//     rather than argued.
// ============================================================

import type * as esbuild from "esbuild-wasm";
import { moduleUrl, resolveFromModuleUrl } from "./cdn";
import { base64ToBytes, placeholderBytesFor, previewLoaderFor } from "./assets";
import { stripVendorCss, type CssPlan } from "./css-pipeline";
import { transformImportMetaGlob } from "./glob";
import { isBundlerInternal, isNodeBuiltin, splitBareSpecifier } from "./module-resolution";
import { resolveAlias, type AliasConfig } from "./aliases";
import type { VFS } from "./vfs";

/** Namespaces this plugin owns. esbuild keys its module cache by them. */
export const WORKSPACE_NS = "vfs";
export const REMOTE_NS = "cdn";
export const STUB_NS = "stub";

/** Vite query suffixes the browser has no equivalent for */
const VITE_QUERY_RE = /^(.*?)\?(.+)$/;

/**
 * What the build learned. Collected DURING the build rather than predicted
 * from a pre-scan, so the report describes what actually happened.
 */
export interface GraphReport {
  /** Local specifiers that name no file in the workspace */
  missingLocal: Set<string>;
  /** Vite query suffixes dropped to keep the import runnable */
  queryStripped: Set<string>;
  /** Host URLs that were fetched (so the pane can show what the app needs) */
  remoteUrls: Set<string>;
  /** Specifiers with no destination at all, keyed by reason */
  unresolved: Map<string, string>;
  /** Workspace assets carried as a placeholder instead of their bytes */
  unavailableAssets: Set<string>;
  /** Vendor CSS directives removed before bundling */
  strippedCss: string[];
  /** Bundler internals stubbed into an empty module (never the user's problem) */
  stubbed: Set<string>;
  /** `import.meta.glob` calls the build could not rewrite, keyed "file → pattern" */
  globUnsupported: Map<string, string>;
}

export function createGraphReport(): GraphReport {
  return {
    missingLocal: new Set(),
    queryStripped: new Set(),
    remoteUrls: new Set(),
    unresolved: new Map(),
    unavailableAssets: new Set(),
    strippedCss: [],
    stubbed: new Set(),
    globUnsupported: new Map(),
  };
}

/** A manifest's resolved version per package (`null` → no publishable version) */
export type PackageVersions = Record<string, string | null>;

export interface PlanInput {
  /** Namespace of the importing module: "vfs" (workspace) or "cdn" (fetched) */
  namespace: string;
  /** The importing module's path — a repo path, or a URL for fetched modules */
  importer: string;
  /** The specifier as written */
  specifier: string;
  /** esbuild's reason for the request; entry points resolve differently */
  kind: string;
  vfs: VFS;
  aliases: AliasConfig;
  versions: PackageVersions;
  report: GraphReport;
}

export type RequestPlan =
  /** A file in the workspace (compiled, or inlined from its bytes) */
  | { kind: "workspace"; path: string }
  /** Module source to fetch from the host */
  | { kind: "remote"; url: string }
  /** A bundler internal, satisfied with an empty module */
  | { kind: "stub"; path: string }
  /**
   * Addressed without any resolution — an absolute URL, a `data:` payload, a
   * fragment. esbuild leaves the reference as written, which is the only
   * correct answer for a CSS `url()`.
   */
  | { kind: "external"; path: string }
  /** Nothing can satisfy this; the build reports it by name */
  | { kind: "unresolved"; reason: string };

/**
 * The resolution policy. Pure: it reads the workspace index and the
 * version map, records what it decided in `report`, and returns a plan.
 *
 * Every path out of here is deliberate. The one that used to exist — "not
 * a file, not a known package, so leave it for the browser" — is gone,
 * because nothing downstream can resolve it any more.
 */
/**
 * A specifier that is ALREADY an address, so nothing has to resolve it.
 *
 * A CSS `url()` is where this matters, and where it broke: design systems
 * carry their noise textures, chevrons and masks as inline `data:` URLs, and
 * an SVG filter is referenced as `url(#id)`. None of those is a module — they
 * are addresses the BROWSER resolves. esbuild hands every `url()` token to the
 * plugin, so all of them reached the package resolver and came back as build
 * errors on perfectly valid stylesheets:
 *
 *   `data:image/svg+xml,%3Csvg…` is not a package name, a relative path, or a
 *   URL, so it cannot be resolved.
 *
 * The message was even self-refuting — a `data:` URL IS a URL — because the
 * check it came from knew only about `http(s)`.
 *
 * Any scheme counts (`data:`, `http:`, `https:`, `blob:`, `mailto:`, …), plus
 * protocol-relative `//host/x` and a bare `#fragment`. Node builtins are
 * excluded on purpose: `node:fs` looks like a scheme and must still be
 * reported as the thing that has no browser implementation.
 */
export function isSelfAddressing(specifier: string): boolean {
  if (specifier.startsWith("//") || specifier.startsWith("#")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier);
}

export function planRequest(input: PlanInput): RequestPlan {
  const { namespace, importer, specifier, kind, vfs, aliases, versions, report } = input;

  // Before everything else: this holds in both namespaces, and a `data:` URL
  // that reached the package resolver was reported as unresolvable.
  if (isSelfAddressing(specifier) && !isNodeBuiltin(specifier)) {
    return { kind: "external", path: specifier };
  }

  // ── Inside a module we fetched from the host ──
  // Everything is relative to that module's own URL: esm.sh's output links
  // its build files as `/v135/...` and its own chunks as `./...`. A bare
  // name here is a dependency esm.sh chose not to inline (the `external=`
  // query), and it resolves through the same version table as the
  // workspace's imports — which is what makes it ONE React.
  if (namespace === REMOTE_NS) {
    const resolved = resolveFromModuleUrl(importer, specifier);
    if (resolved) {
      report.remoteUrls.add(resolved);
      return { kind: "remote", url: resolved };
    }
    const split = splitBareSpecifier(specifier);
    if (!split) {
      const reason = `\`${specifier}\` (imported by ${importer}) is not a package name, a relative path, or a URL, so it cannot be fetched.`;
      report.unresolved.set(specifier, reason);
      return { kind: "unresolved", reason };
    }
    if (isNodeBuiltin(split.pkg)) {
      const reason = `\`${specifier}\` needs the Node.js built-in \`${split.pkg}\`, which has no browser implementation.`;
      report.unresolved.set(specifier, reason);
      return { kind: "unresolved", reason };
    }
    const version = versions[split.pkg];
    if (version === undefined) {
      const reason = `\`${specifier}\` is a dependency of a package you use but is not in this repository's package.json, so no version can be pinned. Add it.`;
      report.unresolved.set(specifier, reason);
      return { kind: "unresolved", reason };
    }
    if (version === null) {
      const reason = `\`${split.pkg}\` is declared without a publishable version, so \`${specifier}\` cannot be fetched.`;
      report.unresolved.set(specifier, reason);
      return { kind: "unresolved", reason };
    }
    const url = moduleUrl(split.pkg, version, split.subpath);
    report.remoteUrls.add(url);
    return { kind: "remote", url };
  }

  // ── Inside the workspace ──
  // Entry points arrive as esbuild normalizes them: an entry given as
  // `src/main.tsx` reaches this callback as `./src/main.tsx`. Normalizing it
  // back is not cosmetic — an unnormalized entry matches no file, so every
  // build reported its own entry point as unloaded.
  if (kind === "entry-point") {
    // Both decorations are stripped, not just `./`: an HTML entry names its
    // script as a root-relative URL (`/src/main.jsx`), and a path that never
    // matches a workspace file makes the build report its own entry point as
    // a file whose contents were not loaded. The caller resolves that URL
    // (entry.ts) — this is the last line of defence for anything that still
    // arrives decorated.
    return { kind: "workspace", path: specifier.replace(/^\.?\/+/, "") };
  }
  if (vfs.exists(specifier)) {
    return { kind: "workspace", path: specifier };
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = vfs.resolveRel(importer, specifier);
    if (resolved) return { kind: "workspace", path: resolved };
    report.missingLocal.add(specifier);
    const reason = `\`${specifier}\` (imported by ${importer}) is not a file in the workspace, so it cannot be bundled.`;
    report.unresolved.set(specifier, reason);
    return { kind: "unresolved", reason };
  }

  // Aliases before packages: `@/lib/utils` is not a package, and treating
  // it as one aborts the module graph.
  const aliased = resolveAlias(specifier, aliases, (p) => vfs.exists(p));
  if (aliased) return { kind: "workspace", path: aliased };

  // A Vite query suffix names behaviour the browser has no equivalent for
  // (?raw, ?url, ?worker). Dropping it keeps the import runnable; the
  // report says the semantics are now approximate.
  const query = VITE_QUERY_RE.exec(specifier);
  if (query) {
    const base = query[1] as string;
    report.queryStripped.add(specifier);
    if (vfs.exists(base)) return { kind: "workspace", path: base };
    const resolved = vfs.resolveRel(importer, base);
    if (resolved) return { kind: "workspace", path: resolved };
    return planBare(base, splitBareSpecifier(base), versions, report);
  }

  return planBare(specifier, splitBareSpecifier(specifier), versions, report);
}

/** Bare-specifier resolution, shared by the plain and query-stripped paths */
function planBare(
  specifier: string,
  split: { pkg: string; subpath: string } | null,
  versions: PackageVersions,
  report: GraphReport
): RequestPlan {
  if (!split) {
    const reason = `\`${specifier}\` is not a package name, a relative path, or a URL, so it cannot be resolved.`;
    report.unresolved.set(specifier, reason);
    return { kind: "unresolved", reason };
  }
  if (isBundlerInternal(specifier)) {
    report.stubbed.add(specifier);
    return { kind: "stub", path: specifier };
  }
  if (isNodeBuiltin(split.pkg)) {
    const reason = `\`${specifier}\` needs the Node.js built-in \`${split.pkg}\`, which has no browser implementation.`;
    report.unresolved.set(specifier, reason);
    return { kind: "unresolved", reason };
  }
  const version = versions[split.pkg];
  if (version === undefined) {
    const reason = `\`${specifier}\` is not in this repository's package.json, so the preview cannot fetch it.`;
    report.unresolved.set(specifier, reason);
    return { kind: "unresolved", reason };
  }
  if (version === null) {
    const reason = `\`${split.pkg}\` is declared without a publishable version (a workspace:, file: or git range), so \`${specifier}\` cannot be fetched.`;
    report.unresolved.set(specifier, reason);
    return { kind: "unresolved", reason };
  }
  const url = moduleUrl(split.pkg, version, split.subpath);
  report.remoteUrls.add(url);
  return { kind: "remote", url };
}

// ── Ports ────────────────────────────────────────────────────

/**
 * The network, injected. Keeping these as ports is what lets the whole
 * bundler run in a test with a fake module host — and the assertions that
 * matter ("exactly one React", "nothing left unresolved") are statements
 * about a real bundle, not about a mock's call log.
 */
export interface FetchedModule {
  /** The module's source text */
  source: string;
  /**
   * The URL the source actually came from, after redirects.
   *
   * esm.sh answers `https://esm.sh/react@19.3.0` by redirecting to its built
   * path, and the source's own relative imports (`./chunk.mjs`) only mean
   * anything relative to THAT url. It is also the module's identity: two
   * specifiers that redirect to the same build become one module, which is
   * how a single React instance is GUARANTEED rather than requested.
   */
  finalUrl: string;
}

export interface GraphPorts {
  /** Source of a module on the host. Throws when it cannot be fetched. */
  fetchModule(url: string): Promise<FetchedModule>;
  /** Base64 bytes of an asset in the attached repository, or null. */
  assetBase64(path: string): Promise<string | null>;
}

export interface GraphOptions {
  vfs: VFS;
  aliases: AliasConfig;
  versions: PackageVersions;
  cssPlan: CssPlan;
  report: GraphReport;
  ports: GraphPorts;
}

/** The plugin. Everything interesting lives in `planRequest` above. */
export function workspaceGraphPlugin(options: GraphOptions): esbuild.Plugin {
  const { vfs, aliases, versions, cssPlan, report, ports } = options;
  /**
   * Sources already fetched, keyed by the URL they came from.
   *
   * onResolve fetches, so a module's PATH is the URL it finally came from;
   * onLoad only reads this map. Fetching in onResolve rather than onLoad is
   * what makes the identity the final URL — otherwise a redirect would give
   * one package two module objects, which is the duplicate-React bug in a
   * new costume.
   */
  const sources = new Map<string, string>();
  const finalUrlOf = new Map<string, string>();

  const fetchRemote = async (url: string): Promise<string> => {
    const known = finalUrlOf.get(url);
    if (known) return known;
    const fetched = await ports.fetchModule(url);
    finalUrlOf.set(url, fetched.finalUrl);
    sources.set(fetched.finalUrl, fetched.source);
    return fetched.finalUrl;
  };

  return {
    name: "intab-preview-graph",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        const plan = planRequest({
          namespace: args.namespace,
          importer: args.importer,
          specifier: args.path,
          kind: args.kind,
          vfs,
          aliases,
          versions,
          report,
        });

        switch (plan.kind) {
          case "workspace":
            return { path: plan.path, namespace: WORKSPACE_NS };
          case "stub":
            return { path: plan.path, namespace: STUB_NS };
          case "external":
            // `external: true` keeps the reference byte-for-byte, which is what
            // a CSS `url(data:…)` needs: the browser fetches it, not us.
            return { path: plan.path, external: true };
          case "unresolved":
            return { errors: [{ text: plan.reason }] };
          case "remote": {
            try {
              const finalUrl = await fetchRemote(plan.url);
              report.remoteUrls.add(finalUrl);
              return { path: finalUrl, namespace: REMOTE_NS };
            } catch (err) {
              const detail = err instanceof Error ? err.message : "fetch failed";
              return {
                errors: [
                  {
                    text:
                      `Could not fetch \`${plan.url}\` from the module host (${detail}). ` +
                      "The package is declared in package.json, so this is usually the network, or a version the host does not publish.",
                  },
                ],
              };
            }
          }
        }
      });

      build.onLoad({ filter: /.*/, namespace: WORKSPACE_NS }, async (args) => {
        const loader = previewLoaderFor(args.path);
        if (loader === null) {
          return {
            errors: [
              {
                text:
                  `The preview cannot load \`${args.path}\`: this file type has no loader. ` +
                  "Source files, stylesheets, JSON, plain text and common web assets (images, fonts, media) are supported. " +
                  "Import the file as a URL instead, or vendor a browser-ready copy into the repository.",
              },
            ],
          };
        }
        const resolveDir = args.path.split("/").slice(0, -1).join("/") || ".";

        // An asset is carried by its BYTES. The workspace is a text store,
        // so reading one as text either fails or hands the parser a lossy
        // decode of an image to parse as source.
        if (loader === "dataurl") {
          const base64 = await ports.assetBase64(args.path);
          if (base64 === null) report.unavailableAssets.add(args.path);
          const bytes = base64 ? base64ToBytes(base64) : placeholderBytesFor(args.path);
          return { contents: bytes, loader, resolveDir };
        }

        const content = vfs.read(args.path);
        if (content === null) {
          return {
            errors: [
              {
                text:
                  `\`${args.path}\` is in the repository but its contents were not loaded, so it cannot be bundled. ` +
                  "This usually means the file could not be fetched (binary, or over the API's size limit).",
              },
            ],
          };
        }
        // Vite's import.meta.glob is a BUILD-TIME api, not a browser one: Vite
        // replaces the call with a static map of imports while building. Left
        // alone it reaches the browser, `import.meta` is an ordinary empty
        // object, and the app dies while its entry module initialises —
        // "(intermediate value).glob is not a function", which names neither
        // the file nor the api, and leaves an empty frame behind.
        let contents = content;
        if (loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx") {
          const globbed = transformImportMetaGlob({
            code: contents,
            importer: args.path,
            paths: vfs.paths(),
            read: (path) => vfs.read(path),
          });
          contents = globbed.code;
          for (const miss of globbed.unsupported) {
            report.globUnsupported.set(`${args.path} → ${miss.pattern}`, miss.reason);
          }
        }

        // Vendor directives are removed HERE, where a stylesheet is actually
        // read: `@import "tailwindcss"` is a package import to esbuild and a
        // directive the browser cannot execute, so leaving it in either fails
        // the build or produces an unstyled page.
        if (loader === "css") {
          const stripped = stripVendorCss(content, cssPlan);
          contents = stripped.css;
          report.strippedCss.push(...stripped.stripped);
        }
        return { contents, loader, resolveDir };
      });

      build.onLoad({ filter: /.*/, namespace: REMOTE_NS }, async (args) => {
        // onResolve already fetched this — that is how the path BECAME the
        // final URL. The fallback is for a path this plugin never resolved,
        // which must still load rather than fail with nothing to read.
        const known = sources.get(args.path);
        if (known !== undefined) return { contents: known, loader: "js" };
        try {
          const fetched = await ports.fetchModule(args.path);
          sources.set(fetched.finalUrl, fetched.source);
          return { contents: fetched.source, loader: "js" };
        } catch (err) {
          const detail = err instanceof Error ? err.message : "fetch failed";
          return {
            errors: [{ text: `Could not fetch \`${args.path}\` from the module host (${detail}).` }],
          };
        }
      });

      // Bundler internals (`@vite/client`, `virtual:*`) are imported by
      // generated code, never by the user. An empty module keeps the graph
      // intact where refusing would fail a project that is otherwise fine.
      build.onLoad({ filter: /.*/, namespace: STUB_NS }, () => ({
        contents: "export default {};",
        loader: "js",
      }));
    },
  };
}
