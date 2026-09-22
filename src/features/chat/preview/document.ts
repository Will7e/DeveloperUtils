// ============================================================
// Preview Document — The Page a Build Renders Into
// ============================================================
// A repository that ships index.html IS that document. The preview used to
// ignore it and render a generated stub instead:
//
//   <body><div id="root"></div><script type="module">…</script></body>
//
// That stub is wrong for every real app in the same way. An app that mounts
// into `#app` finds nothing and throws inside createRoot; one that styles
// `body`, sets a viewport, or renders into markup that already exists (a
// splash screen, a `<noscript>`, a `<div id="root">` nested in a layout)
// loses all of it. The build SUCCEEDS — the stub is a valid document — so
// the pane shows a black frame, a green "Ready" badge, and nothing at all
// to diagnose. The reported symptom, exactly.
//
// So the repository's document is the shell, and the bundle is injected into
// it. The one thing that must be taken OUT is the app's own module script:
// the bundle IS that script now, and leaving it in makes the frame request a
// module the host does not serve (in the inline path it simply fails there).
//
// Pure string work on purpose. Getting the injection order wrong is
// invisible until a frame goes empty, and this is the part that can be
// asserted without a browser.
// ============================================================

export interface ComposeDocumentOptions {
  /** The bundle: one self-contained module, or "" for a static document */
  js: string;
  /** The bundle's CSS, inlined so a rebuild can hot-swap it */
  css: string;
  /** Runtime module URLs the CSS plan needs (Tailwind's browser build) */
  scripts: string[];
  /** The bridge/prelude script, already serialized */
  bridge: string;
  /**
   * The repository's own entry document. Undefined means the project has no
   * HTML at all (a bare JS/TS entry), which is the only case where a stub is
   * the honest answer.
   */
  staticHtml?: string;
  /** The module script the bundle replaces, when the entry is an HTML file */
  replacedScriptSrc?: string | null;
}

/** The mount point a stub document offers, matching the Vite convention */
const STUB_MOUNT_ID = "root";

export function composeEntryHtml(options: ComposeDocumentOptions): string {
  const { js, css, scripts, bridge, staticHtml, replacedScriptSrc } = options;

  // Runtime stylesheets stay separate scripts so one failing cannot swallow
  // the bundle, and the bridge (console capture + the capability prelude)
  // must precede everything the app runs.
  const runtimeTags = scripts
    .map((url) => `<script type="module" src="${url}"></script>`)
    .join("\n");
  const headMarkup = [css ? `<style id="intab-app-css">${css}</style>` : "", runtimeTags, bridge]
    .filter(Boolean)
    .join("\n");
  const bundleTag = js ? `<script type="module">${js}</script>` : "";

  if (staticHtml === undefined) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headMarkup}
</head>
<body>
<div id="${STUB_MOUNT_ID}"></div>
${bundleTag}
</body>
</html>`;
  }

  const withoutAppScript = replacedScriptSrc
    ? removeScriptTag(staticHtml, replacedScriptSrc)
    : staticHtml;
  // The bundle goes last, at the END of the body: the app's own markup has to
  // exist before the module runs and looks for its mount point.
  return injectIntoBody(
    ensureViewport(injectIntoHead(withoutAppScript, headMarkup)),
    bundleTag
  );
}

/**
 * Guarantees a viewport declaration.
 *
 * A document without one is laid out at a default logical width (980px) and
 * then SCALED to fit whatever viewport is showing it. In a pane that emulates
 * a device — which a preview pane does — that reads as a page rendered zoomed
 * in, for the projects whose HTML happens to omit the tag (a plain static
 * page, a hand-written index.html, a project with no HTML at all, which gets
 * the stub). Injecting it is what a scaffolded Vite project already has, so
 * this only ever adds what was missing.
 */
function ensureViewport(html: string): string {
  if (/<meta[^>]+name\s*=\s*["']?viewport/i.test(html)) return html;
  return injectIntoHead(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
  );
}

/**
 * Removes the script tag that loaded `src`, whatever attribute order or
 * quoting it used.
 *
 * Exactly this tag, never `<script>` generally: the page may also load
 * analytics, a legacy bundle, or a polyfill, and removing those would change
 * the app rather than rebuild it. An unquoted `src=main.jsx` is legal HTML,
 * so it matches too.
 */
export function removeScriptTag(html: string, src: string): string {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<script\\b[^>]*?\\bsrc\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped}(?=[\\s/>]))[^>]*>\\s*<\\/script\\s*>`,
    "gi"
  );
  return html.replace(pattern, "");
}

/** Inserts markup at the end of `<head>`, or ahead of the document if it has none */
export function injectIntoHead(html: string, markup: string): string {
  if (!markup) return html;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${markup}\n$&`);
  return `${markup}\n${html}`;
}

/** Inserts markup at the end of `<body>`, or appends it if the document has none */
export function injectIntoBody(html: string, markup: string): string {
  if (!markup) return html;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${markup}\n$&`);
  return `${html}\n${markup}`;
}
