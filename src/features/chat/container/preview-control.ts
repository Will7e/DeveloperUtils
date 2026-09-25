// ============================================================
// Preview Control Bootstrap — Serialization Source (Pure)
// ============================================================
// The string injected into the preview's index.html at mount time, and the
// DOM→text serializer it uses, live here — as PURE functions over strings
// and plain objects, unit-testable without an iframe.
//
// The bridge (preview-control.ts) decides WHEN to inject and how to carry
// messages; this module only answers "what does the injected code look like"
// and "how does a DOM become an outline". Keeping the two apart is what lets
// the serializer be tested against jsdom-free fixtures and the protocol be
// versioned without re-reading a wall of string code.
//
// Serialization rules, in the order they matter:
//
//   • TEXT first, tags second — the model reads an outline, not HTML.
//   • Interactive elements get STABLE uids (p1, b3, i2…), because a
//     snapshot the agent cannot act on by reference is a dead end.
//   • Deeply nested structure is FLATTENED with indentation, and the whole
//     outline is capped: a runaway page must not turn one snapshot into a
//     context problem.
//   • Script and style contents never appear — the outline describes the
//     page the user sees, not its source.
// ============================================================

/** Bump when the bootstrap ⇄ host message contract changes */
export const PREVIEW_CONTROL_PROTOCOL_VERSION = 1;

/** Bounds for one snapshot, enforced at serialization time */
export const PREVIEW_SNAPSHOT_MAX_CHARS = 12_000;
export const PREVIEW_SNAPSHOT_MAX_NODES = 400;

/** The postMessage verbs, spelled out so host and bootstrap agree */
export const PREVIEW_CONTROL_REQUEST = "intab-preview-control";
export const PREVIEW_CONTROL_RESPONSE = "intab-preview-control-result";

/**
 * One interactive element in the outline.
 *
 * `uid` is what preview_interact passes back; it is positional (document
 * order) and only stable WITHIN a snapshot, so a page that re-renders must
 * be re-snapshotted before acting — the tool docs say so.
 */
export interface OutlineNode {
  uid: string | null;
  kind: "heading" | "text" | "button" | "link" | "input" | "select" | "image" | "other";
  /** The readable text (label, value, alt) */
  label: string;
  /** Indentation depth, so the outline reads as a tree after flattening */
  depth: number;
}

export interface SerializedSnapshot {
  nodes: OutlineNode[];
  /** Total nodes seen before the cap — stated, never silently dropped */
  totalNodes: number;
  truncated: boolean;
  title: string;
  url: string;
}

const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "template", "head"]);

/** The kind an outline row carries, decided once per element */
function kindOf(tagName: string): OutlineNode["kind"] {
  switch (tagName) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
    case "textarea":
      return "input";
    case "select":
      return "select";
    case "img":
      return "image";
    default:
      return "other";
  }
}

/** The readable text of one element, by kind */
function labelOf(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "img") return element.getAttribute("alt") ?? "(image)";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    const value = element.getAttribute("value") ?? "";
    const placeholder = element.getAttribute("placeholder");
    if (type === "submit" || type === "button") return value || "(button)";
    return placeholder ? `input “${placeholder}”` : `input${value ? `: ${value}` : ""}`;
  }
  if (tag === "select") return element.getAttribute("name") ?? "(select)";
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || `(${tag})`;
}

/**
 * Serializes a document into the capped text outline.
 *
 * Runs on the BOOTSTRAP side in production; tested here as a pure function
 * over a DOM-like tree. Only the Element/DOM API surface is used, so a jsdom
 * fixture exercises the real logic.
 */
export function serializeSnapshot(document: Document): SerializedSnapshot {
  const nodes: OutlineNode[] = [];
  let totalNodes = 0;
  // Per-tag counters (a1, b1, i2, p1…): short, and the prefix says what
  // kind of thing the uid names — easier for a model to reason about than
  // a global sequence.
  const counters = new Map<string, number>();
  const nextUid = (tag: string): string => {
    const n = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, n);
    return `${tag[0] ?? "e"}${n}`;
  };

  const visit = (element: Element, depth: number): void => {
    if (nodes.length >= PREVIEW_SNAPSHOT_MAX_NODES) {
      totalNodes += 1;
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;

    const isInteractive = INTERACTIVE.has(tag);
    const isHeading = kindOf(tag) === "heading";
    const hasOwnText = isInteractive || isHeading || tag === "img" || (element.children.length === 0 && (element.textContent ?? "").trim().length > 0);

    // Only nodes that would APPEAR count toward the total: a bare container
    // renders nothing, and counting it would make an empty page read as
    // "truncated". `truncated` must mean "there was more to show".
    if (hasOwnText) {
      totalNodes += 1;
      const uid = isInteractive ? nextUid(tag) : null;
      nodes.push({ uid, kind: kindOf(tag), label: labelOf(element), depth });
    }

    for (const child of Array.from(element.children)) {
      visit(child, depth + 1);
    }
  };

  if (document.body) visit(document.body, 0);

  return {
    nodes,
    totalNodes,
    truncated: totalNodes > nodes.length,
    title: document.title ?? "",
    url: document.location?.href ?? "",
  };
}

/** The outline as the TEXT the model reads (indentation by depth, capped) */
export function formatOutline(snapshot: SerializedSnapshot): string {
  const lines: string[] = [];
  if (snapshot.title) lines.push(`# ${snapshot.title}`);
  for (const node of snapshot.nodes) {
    const indent = "  ".repeat(Math.min(node.depth, 8));
    const uid = node.uid ? ` [${node.uid}]` : "";
    lines.push(`${indent}- ${node.kind}${uid}: ${node.label}`);
  }
  if (snapshot.truncated) {
    lines.push(`… (${snapshot.totalNodes} elements on the page; showing the first ${snapshot.nodes.length})`);
  }
  const out = lines.join("\n");
  return out.length > PREVIEW_SNAPSHOT_MAX_CHARS
    ? `${out.slice(0, PREVIEW_SNAPSHOT_MAX_CHARS)}\n… (outline truncated)`
    : out;
}

/**
 * The bootstrap's raw JavaScript, without the `<script>` wrapper.
 *
 * This is the form the RUNTIME needs: `WebContainer.setPreviewScript` injects
 * a script tag into every HTML response the runtime serves — the mechanism
 * bolt.diy uses for its inspector, and the only one that reaches pages a dev
 * server GENERATES (Next.js, Nuxt), where no index.html exists to rewrite at
 * mount time. `bootstrapSource` wraps it for the mount-time injection, which
 * remains as the belt to this suspenders.
 */
export function bootstrapScriptBody(): string {
  return `(function () {
  if (window.__intabPreviewControl) return;
  window.__intabPreviewControl = ${PREVIEW_CONTROL_PROTOCOL_VERSION};
  var REQUEST = ${JSON.stringify(PREVIEW_CONTROL_REQUEST)};
  var RESPONSE = ${JSON.stringify(PREVIEW_CONTROL_RESPONSE)};
  var MAX_EVAL_RESULT_CHARS = 4000;

  function safeStringify(value) {
    try {
      var json = JSON.stringify(value, function (key, v) {
        if (typeof v === "function") return "[function]";
        if (v instanceof Error) return String(v);
        return v;
      });
      if (typeof json !== "string") return String(json);
      return json.length > MAX_EVAL_RESULT_CHARS
        ? json.slice(0, MAX_EVAL_RESULT_CHARS) + "…(truncated)"
        : json;
    } catch (err) {
      return "unserializable: " + String(err);
    }
  }

  function handle(message) {
    if (!message || message.channel !== REQUEST || typeof message.id !== "string") return;
    var result;
    try {
      switch (message.op) {
        case "ping":
          result = { ok: true, version: ${PREVIEW_CONTROL_PROTOCOL_VERSION} };
          break;
        case "get-tree":
          result = { ok: true, snapshot: window.__intabSerialize(document) };
          break;
        case "click": {
          var el = document.querySelector("[data-intab-uid='" + message.uid + "']");
          if (!el) { result = { ok: false, error: "no element with uid " + message.uid }; break; }
          el.scrollIntoView({ block: "center" });
          el.click();
          result = { ok: true };
          break;
        }
        case "type": {
          var input = document.querySelector("[data-intab-uid='" + message.uid + "']");
          if (!input) { result = { ok: false, error: "no element with uid " + message.uid }; break; }
          input.focus();
          input.value = message.text == null ? "" : String(message.text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          result = { ok: true };
          break;
        }
        case "press": {
          var key = message.text == null ? "Enter" : String(message.text);
          var active = document.activeElement || document.body;
          active.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
          active.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true }));
          result = { ok: true };
          break;
        }
        case "wait-for": {
          // Bounded inside the bootstrap: the host applies its own timeout,
          // this one keeps a poll loop from outliving the request. The
          // deadline is pinned to the FIRST entry: the handler re-enters on
          // every poll tick, so a deadline computed per entry would reset
          // itself and never fire. (No backticks in these comments — this
          // code lives inside a template literal.)
          var text = message.text == null ? "" : String(message.text);
          if (!message.__deadline) message.__deadline = Date.now() + 5000;
          var found = !!(document.body && document.body.textContent &&
            document.body.textContent.indexOf(text) !== -1);
          if (found || Date.now() > message.__deadline) {
            result = { ok: true, found: found };
          } else {
            setTimeout(function () { handle(message); }, 120);
            return;
          }
          break;
        }
        case "evaluate":
          result = { ok: true, value: safeStringify((0, eval)(message.expression)) };
          break;
        default:
          result = { ok: false, error: "unknown op " + String(message.op) };
      }
    } catch (err) {
      result = { ok: false, error: String(err) };
    }
    var reply = { channel: RESPONSE, id: message.id, result: result };
    try {
      window.parent.postMessage(reply, "*");
    } catch (err) {
      // A parent that refused the message (sandbox) — nothing else to do.
    }
  }

  // Tag interactive elements with the uids the serializer assigned, so
  // click/type can find them again. Re-tagged on every snapshot, because
  // the page re-renders.
  window.__intabSerialize = function (doc) {
    var nodes = [];
    var total = 0;
    var interactive = 0;
    var SKIP = { script: 1, style: 1, noscript: 1, svg: 1, template: 1, head: 1 };
    function labelOf(el) {
      var tag = el.tagName.toLowerCase();
      if (tag === "img") return el.getAttribute("alt") || "(image)";
      if (tag === "input") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        var value = el.getAttribute("value") || "";
        var ph = el.getAttribute("placeholder");
        if (type === "submit" || type === "button") return value || "(button)";
        return ph ? "input '" + ph + "'" : "input" + (value ? ": " + value : "");
      }
      if (tag === "select") return el.getAttribute("name") || "(select)";
      var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      return text || "(" + tag + ")";
    }
    function visit(el, depth) {
      if (nodes.length >= ${PREVIEW_SNAPSHOT_MAX_NODES}) return;
      var tag = el.tagName.toLowerCase();
      if (SKIP[tag]) return;
      var interactiveTag = tag === "a" || tag === "button" || tag === "input" || tag === "textarea" || tag === "select";
      var heading = /^h[1-6]$/.test(tag);
      var own = interactiveTag || heading || tag === "img" ||
        (el.children.length === 0 && (el.textContent || "").trim().length > 0);
      // Same rule as the host-side serializer: only visible rows count.
      if (own) {
        total += 1;
        var uid = null;
        if (interactiveTag) {
          interactive += 1;
          uid = tag[0] + interactive;
          el.setAttribute("data-intab-uid", uid);
        }
        nodes.push({ uid: uid, kind: heading ? "heading" : tag === "a" ? "link" : tag === "button" ? "button" : tag === "img" ? "image" : interactiveTag ? "input" : "other", label: labelOf(el), depth: depth });
      }
      for (var i = 0; i < el.children.length; i += 1) visit(el.children[i], depth + 1);
    }
    if (doc.body) visit(doc.body, 0);
    return { nodes: nodes, totalNodes: total, truncated: total > nodes.length, title: doc.title || "", url: doc.location ? doc.location.href : "" };
  };

  window.addEventListener("message", function (event) {
    handle(event.data);
  });

  try {
    window.parent.postMessage({ channel: RESPONSE, id: "bootstrap", result: { ok: true, version: ${PREVIEW_CONTROL_PROTOCOL_VERSION}, event: "ready" } }, "*");
  } catch (err) {
    // Sandboxed or absent parent — the host discovers readiness by polling.
  }
})();`;
}

/**
 * The bootstrap source, injected into index.html at mount time.
 *
 * It listens for control requests on window messages, acts on the page, and
 * answers with a versioned result. The listener tolerates being injected
 * TWICE (a re-mount over an already-injected tree, or the runtime script plus
 * this one): the second copy sees the first's flag and leaves the original in
 * place, so handlers never stack.
 */
export function bootstrapSource(): string {
  return `<script data-intab-preview-control="${PREVIEW_CONTROL_PROTOCOL_VERSION}">\n${bootstrapScriptBody()}\n</script>`;
}

/**
 * Injects the bootstrap into an HTML document's source.
 *
 * The script goes as EARLY as possible (right after the first <head> or
 * <html> open tag, or at the very start for a fragment) so the listener is
 * up before the app's own scripts can navigate or replace the body.
 *
 * Idempotent: a document already carrying the marker is returned unchanged,
 * because re-mounting a revision must not stack a second listener.
 */
export function injectBootstrap(html: string): string {
  if (html.includes("data-intab-preview-control")) return html;
  const source = bootstrapSource();
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}\n${source}${html.slice(at)}`;
  }
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen && htmlOpen.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}\n${source}${html.slice(at)}`;
  }
  return `${source}\n${html}`;
}

/** True when an index.html-shaped document is present in the tree at all */
export function looksLikeHtmlDocument(content: string): boolean {
  return /<html[\s>]/i.test(content) || /<!doctype html/i.test(content);
}
