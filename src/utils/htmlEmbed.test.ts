import { describe, expect, it } from "vitest";
import { escapeHtmlAttribute, safeJsonForHtml } from "./htmlEmbed";

describe("safeJsonForHtml", () => {
  it("neutralizes a script-terminating payload", () => {
    const out = safeJsonForHtml({ ok: false, error: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("\\u003c/script\\u003e");
  });

  it("neutralizes comment and attribute breakouts", () => {
    const out = safeJsonForHtml({ error: "<!--><img src=x onerror=alert(1)>" });
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c!--\\u003e");
  });

  it("escapes the ampersand and JS line separators", () => {
    const out = safeJsonForHtml({ error: "a&b\u2028c\u2029d" });
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toContain("\u2028");
  });

  it("stays valid JSON that round-trips to the original value", () => {
    const value = { ok: true, state: "abc", note: "<b>&</b>" };
    const out = safeJsonForHtml(value);
    // The escapes are JSON string escapes, so parsing recovers the input.
    expect(JSON.parse(out)).toEqual(value);
  });

  it("handles null and undefined without producing the literal undefined", () => {
    expect(safeJsonForHtml(undefined)).toBe("null");
    expect(safeJsonForHtml(null)).toBe("null");
  });

  it("is safe inside a script data block for nested quotes", () => {
    const out = safeJsonForHtml({ error: `"'</script>"` });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out)).toEqual({ error: `"'</script>"` });
  });
});

describe("escapeHtmlAttribute", () => {
  it("keeps ordinary origins intact", () => {
    expect(escapeHtmlAttribute("https://in-tab.se")).toBe("https://in-tab.se");
    expect(escapeHtmlAttribute("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("strips characters that could break out of the attribute", () => {
    const out = escapeHtmlAttribute('" onload="alert(1)');
    expect(out).not.toMatch(/["'<>=\s()]/);
    expect(out).toContain("onload");
  });

  it("removes tag delimiters and quotes entirely", () => {
    expect(escapeHtmlAttribute("<script>")).toBe("script");
    expect(escapeHtmlAttribute('a"b\'c`d')).toBe("abcd");
  });
});
