// ============================================================
// Preview Document — Regression Suite
// ============================================================
// The failure these pin, reported as "the preview is black": a build that
// SUCCEEDS while rendering nothing, because the repository's index.html was
// discarded in favour of a stub with a hardcoded `#root`. An app that mounts
// `#app` throws inside createRoot; one that styles `body` or already renders
// markup loses all of it; and a green "Ready" badge on an empty frame is the
// hardest kind of bug to report.
// ============================================================

import { describe, it, expect } from "vitest";
import { composeEntryHtml, injectIntoBody, injectIntoHead, removeScriptTag } from "./document";

const BRIDGE = "<script>(function(){})();</script>";

/** A Vite-shaped entry: markup the app mounts into, plus its module script */
const VITE_INDEX = `<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body class="bg-slate-950 text-white">
    <div id="app"><noscript>Enable JavaScript</noscript></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`;

describe("composeEntryHtml — a repository that ships its own document", () => {
  const composed = () =>
    composeEntryHtml({
      js: "console.log('bundle')",
      css: ".a{color:red}",
      scripts: [],
      bridge: BRIDGE,
      staticHtml: VITE_INDEX,
      replacedScriptSrc: "/src/main.jsx",
    });

  it("keeps the app's own markup, mount point, body attributes and meta", () => {
    const html = composed();
    // The mount point the app actually looks for.
    expect(html).toContain('<div id="app">');
    expect(html).toContain("<noscript>Enable JavaScript</noscript>");
    expect(html).toContain('class="bg-slate-950 text-white"');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<title>My App</title>");
    // …and the stub is gone, so nothing can silently mount into the wrong node.
    expect(html).not.toContain('<div id="root">');
  });

  it("replaces the app's own module script instead of loading it twice", () => {
    const html = composed();
    expect(html).not.toContain("/src/main.jsx");
    expect(html).toContain("console.log('bundle')");
    // The bundle is the LAST thing in the body: the markup has to exist
    // before the module runs and looks for its mount point.
    expect(html.indexOf('<div id="app">')).toBeLessThan(html.indexOf("console.log('bundle')"));
    expect(html.indexOf("console.log('bundle')")).toBeLessThan(html.indexOf("</body>"));
  });

  it("runs the bridge before the app, and carries the bundle's CSS", () => {
    const html = composed();
    expect(html).toContain(BRIDGE);
    expect(html).toContain('<style id="intab-app-css">.a{color:red}</style>');
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf("console.log('bundle')"));
    // Injected inside the app's own head, not stacked above the document.
    expect(html.indexOf("<head>")).toBeLessThan(html.indexOf(BRIDGE));
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf("</head>"));
  });

  it("serves a static document (no bundle) without touching its markup", () => {
    const html = composeEntryHtml({
      js: "",
      css: "",
      scripts: ["https://cdn.example/tailwind.js"],
      bridge: BRIDGE,
      staticHtml: VITE_INDEX,
      replacedScriptSrc: null,
    });
    expect(html).toContain('<div id="app">');
    expect(html).toContain("https://cdn.example/tailwind.js");
    expect(html).toContain(BRIDGE);
    // Nothing to execute, so nothing was appended at the end of the body.
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("guarantees a viewport declaration, which is what a zoomed preview usually means", () => {
    // A document with no viewport meta is laid out at a default logical width
    // and scaled by any device-emulating viewport — the reported "the sizing is
    // completely zoomed in" for the projects whose HTML omits the tag.
    const plain = `<!DOCTYPE html><html><head><title>Hand written</title></head><body><div id="app"></div></body></html>`;
    const composed = composeEntryHtml({
      js: "app()",
      css: "",
      scripts: [],
      bridge: BRIDGE,
      staticHtml: plain,
      replacedScriptSrc: null,
    });
    expect(composed).toContain('name="viewport"');
    expect(composed).toContain("width=device-width");

    // A document that already declares one keeps its own, untouched.
    const declared = `<!DOCTYPE html><html><head><meta name="viewport" content="width=1024"></head><body></body></html>`;
    const kept = composeEntryHtml({
      js: "",
      css: "",
      scripts: [],
      bridge: BRIDGE,
      staticHtml: declared,
      replacedScriptSrc: null,
    });
    expect(kept).toContain("width=1024");
    expect(kept).not.toContain("width=device-width");
  });

  it("still renders a JS-only project into a stub, which is all there is", () => {
    const html = composeEntryHtml({
      js: "main()",
      css: "",
      scripts: [],
      bridge: BRIDGE,
      staticHtml: undefined,
    });
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("main()");
    expect(html.indexOf('<div id="root">')).toBeLessThan(html.indexOf("main()"));
    expect(html).toContain("<meta charset=\"utf-8\">");
  });
});

describe("HTML surgery", () => {
  it("removes exactly the script that was replaced", () => {
    const html = `<body>
      <script src="/analytics.js"></script>
      <script type="module" src="/src/main.jsx"></script>
      <script src='/src/main.jsx'></script>
      <script src=/src/main.jsx></script>
    </body>`;
    const out = removeScriptTag(html, "/src/main.jsx");
    expect(out).toContain("/analytics.js");
    expect(out).not.toContain("main.jsx");
  });

  it("tolerates documents with no head or body at all", () => {
    const fragment = '<div id="app"></div>';
    expect(injectIntoHead(fragment, "<meta charset=\"utf-8\">")).toContain('id="app"');
    const withBundle = injectIntoBody(fragment, "<script>app()</script>");
    expect(withBundle.indexOf('id="app"')).toBeLessThan(withBundle.indexOf("app()"));
    // Empty markup is never inserted, so an untouched document stays byte-equal.
    expect(injectIntoBody(fragment, "")).toBe(fragment);
    expect(injectIntoHead(fragment, "")).toBe(fragment);
  });
});
