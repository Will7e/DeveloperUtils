import { describe, expect, it } from "vitest";

import {
  WEB_MAX_TEXT_CHARS,
  decodeEntities,
  describeRedirect,
  elide,
  extractTitle,
  flattenWebBody,
  htmlToText,
  isBrowsableUrl,
} from "./web-page";

describe("isBrowsableUrl", () => {
  it("accepts ordinary http and https URLs", () => {
    expect(isBrowsableUrl("https://esm.sh/react@19")).toBe(true);
    expect(isBrowsableUrl("http://example.com/docs?q=1#x")).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", "script execution"],
    ["data:text/html,<script>x</script>", "inlined document"],
    ["file:///etc/passwd", "local file"],
    ["blob:https://x/abc", "blob handle"],
    ["ftp://example.com/x", "non-web scheme"],
    ["not a url", "unparseable"],
    ["", "empty"],
  ])("refuses %s (%s)", (raw) => {
    expect(isBrowsableUrl(raw)).toBe(false);
  });

  it("refuses credentials embedded in the URL", () => {
    // A secret in a URL gets logged, cached and quoted back by the model.
    expect(isBrowsableUrl("https://user:token@example.com/private")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("keeps prose and drops markup", () => {
    const text = htmlToText("<html><body><h1>Title</h1><p>Hello <strong>world</strong>.</p></body></html>");
    expect(text).toContain("# Title");
    expect(text).toContain("Hello world.");
    expect(text).not.toContain("<");
  });

  it("never ships script or style contents to the model", () => {
    const text = htmlToText(
      `<html><head><style>.a{color:red}</style><script>var secret=1;</script></head><body>Real prose</body></html>`,
    );
    expect(text).toContain("Real prose");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var secret");
  });

  it("drops an unclosed script block, which malformed pages produce", () => {
    const text = htmlToText("<body>Intro<script>var junk = 1;\nmore junk");
    expect(text).toContain("Intro");
    expect(text).not.toContain("junk");
  });

  it("keeps list items readable and drops comments", () => {
    const text = htmlToText("<ul><li>one</li><li>two</li></ul><!-- TODO: remove -->");
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(text).not.toContain("TODO");
  });

  it("keeps a link's label but not its href", () => {
    const text = htmlToText(`<p>See <a href="https://example.com/x">the docs</a>.</p>`);
    expect(text).toContain("See the docs.");
    expect(text).not.toContain("example.com");
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &mdash; &#65; &#x42;")).toBe("a & b <c> — A B");
  });

  it("leaves an unknown entity alone rather than deleting it", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("extractTitle", () => {
  it("reads the title tag, decoded", () => {
    expect(extractTitle("<title>React &amp; Friends</title>")).toBe("React & Friends");
  });

  it("falls back to og:title", () => {
    expect(extractTitle(`<meta property="og:title" content="Docs Page">`)).toBe("Docs Page");
  });

  it("returns null when there is no title", () => {
    expect(extractTitle("<body>nothing here</body>")).toBeNull();
  });
});

describe("elide", () => {
  it("leaves text under the limit untouched", () => {
    expect(elide("short", 100)).toEqual({ text: "short", truncated: false });
  });

  it("keeps head and tail and states how much was dropped", () => {
    const text = "0123456789".repeat(100);
    const result = elide(text, 400);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("characters elided");
    // The head and the tail both survive, so a conclusion at the end of a long
    // page is not the part that gets thrown away.
    expect(result.text.startsWith(text.slice(0, 100))).toBe(true);
    expect(result.text.endsWith(text.slice(-50))).toBe(true);
  });
});

describe("flattenWebBody", () => {
  it("extracts HTML and says the structure is approximate", () => {
    const result = flattenWebBody("<html><title>T</title><body><p>Body text</p></body></html>", "text/html; charset=utf-8");
    expect(result.kind).toBe("html");
    expect(result.title).toBe("T");
    expect(result.text).toContain("Body text");
    expect(result.note).toContain("APPROXIMATE");
  });

  it("treats JSON as text without stripping it", () => {
    const result = flattenWebBody(`{"a":1}`, "application/json");
    expect(result.kind).toBe("json");
    expect(result.text).toBe(`{"a":1}`);
    expect(result.note).toContain("JSON");
  });

  it("refuses binary rather than decoding it into nonsense", () => {
    const result = flattenWebBody("\x00\x01binary", "application/pdf");
    expect(result.kind).toBe("unsupported");
    expect(result.text).toBe("");
    expect(result.note).toContain("application/pdf");
  });

  it("detects HTML served with a wrong content type", () => {
    const result = flattenWebBody("<!DOCTYPE html><html><body>Hi</body></html>", "text/plain");
    expect(result.kind).toBe("html");
    expect(result.text).toContain("Hi");
  });

  it("respects the character budget", () => {
    const result = flattenWebBody(`<p>${"word ".repeat(10_000)}</p>`, "text/html", 500);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(WEB_MAX_TEXT_CHARS);
  });
});

describe("describeRedirect", () => {
  it("reports a redirect that changed the destination", () => {
    expect(describeRedirect("https://t.co/x", "https://example.com/real")).toBe(
      "Redirected to https://example.com/real",
    );
  });

  it("is silent when the URL only gained or lost a trailing slash", () => {
    expect(describeRedirect("https://example.com/docs", "https://example.com/docs/")).toBeNull();
  });
});
