import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffLineClass } from "./diff-lines";

describe("classifyDiffLine", () => {
  it("classifies file headers as meta", () => {
    expect(classifyDiffLine("--- a/src/App.tsx")).toBe("meta");
    expect(classifyDiffLine("+++ b/src/App.tsx")).toBe("meta");
    expect(classifyDiffLine("--- /dev/null")).toBe("meta");
    expect(classifyDiffLine("+++ /dev/null")).toBe("meta");
  });

  it("classifies hunk headers", () => {
    expect(classifyDiffLine("@@ -1,4 +1,6 @@")).toBe("hunk");
  });

  it("classifies additions and deletions", () => {
    expect(classifyDiffLine("+import { fetchUser } from \"./api\";")).toBe("add");
    expect(classifyDiffLine("-  return null;")).toBe("del");
  });

  it("classifies the truncation gap", () => {
    expect(classifyDiffLine("…[diff truncated]")).toBe("gap");
  });

  it("classifies context and blank lines", () => {
    expect(classifyDiffLine("export default function App() {")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });

  it("treats a removed '--' comment as a deletion, not a header", () => {
    // A line of `-- sql comment` in a removed block arrives as `--- …`
    // and must not swallow the rest of the file into "meta".
    expect(classifyDiffLine("---- an SQL comment")).toBe("del");
    expect(classifyDiffLine("---# a yaml doc separator")).toBe("del");
  });

  it("treats an added '++'-looking line as an addition", () => {
    expect(classifyDiffLine("+++i++;")).toBe("add");
  });
});

describe("diffLineClass", () => {
  it("maps to the shared chat classes", () => {
    expect(diffLineClass("+x")).toBe("chat-diff-line chat-diff-line-add");
    expect(diffLineClass("@@ -1 +1 @@")).toBe("chat-diff-line chat-diff-line-hunk");
  });
});
