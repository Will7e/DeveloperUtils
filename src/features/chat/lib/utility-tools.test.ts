// ============================================================
// Utility Tools — Executor Tests
// ============================================================
// Same seam the app-tools tests cover: a model's arguments against a
// pure local engine, argument refusals the model can read and adapt to,
// and honest framing in the result. All pure — no mocks needed.

import { describe, expect, it } from "vitest";
import {
  convertDataTool,
  encodeDecodeTool,
  generateCsvTool,
  hashTextTool,
  regexTestTool,
  timestampConvertTool,
  uuidGenerateTool,
} from "./utility-tools";

const errorOf = (result: { data: unknown }): string =>
  String((result.data as { error?: string }).error ?? "");

describe("generate_csv", () => {
  it("serializes flat rows with first-seen column order", () => {
    const result = generateCsvTool({ data: [{ id: 1, name: "a" }, { id: 2, name: "b" }] });
    expect(result.ok).toBe(true);
    const data = result.data as { csv: string; rows: number };
    expect(data.rows).toBe(2);
    expect(data.csv).toBe("id,name\n1,a\n2,b");
  });

  it("quotes cells containing the delimiter, quotes or newlines (RFC 4180)", () => {
    const result = generateCsvTool({ data: [{ a: 'has,comma' }, { a: 'has"quote' }, { a: "line\nbreak" }] });
    const data = result.data as { csv: string };
    expect(data.csv).toBe('a\n"has,comma"\n"has""quote"\n"line\nbreak"');
  });

  it("honors explicit column order and tsv format", () => {
    const result = generateCsvTool({ data: [{ b: "2", a: "1" }], columns: ["a", "b"], format: "tsv" });
    const data = result.data as { csv: string };
    expect(data.csv).toBe("a\tb\n1\t2");
  });

  it("accepts a JSON string of rows", () => {
    const result = generateCsvTool({ data: '[{"x":1}]' });
    expect(result.ok).toBe(true);
  });

  it("refuses nested values instead of stringifying them", () => {
    const result = generateCsvTool({ data: [{ a: { deep: true } }] });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/flatten/i);
  });

  it("refuses an empty array and a bad format", () => {
    expect((generateCsvTool({ data: [] }).ok)).toBe(false);
    expect((generateCsvTool({ data: [{ a: 1 }], format: "xlsx" }).ok)).toBe(false);
  });
});

describe("convert_data", () => {
  it("converts JSON to CSV", () => {
    const result = convertDataTool({ data: '[{"id":1,"n":"x"},{"id":2,"n":"y"}]', from: "json", to: "csv" });
    expect(result.ok).toBe(true);
    expect((result.data as { result: string }).result).toBe("id,n\n1,x\n2,y");
  });

  it("converts a single JSON object as one row", () => {
    const result = convertDataTool({ data: '{"status":"ok"}', from: "json", to: "csv" });
    expect(result.ok).toBe(true);
    expect((result.data as { rows: number }).rows).toBe(1);
  });

  it("converts CSV to JSON with RFC 4180 quoted cells", () => {
    const result = convertDataTool({ data: 'name,note\nx,"has,comma"', from: "csv", to: "json" });
    const data = result.data as { result: string };
    const parsed = JSON.parse(data.result) as Array<{ name: string; note: string }>;
    expect(parsed).toEqual([{ name: "x", note: "has,comma" }]);
  });

  it("converts TSV to JSON", () => {
    const result = convertDataTool({ data: "a\tb\n1\t2", from: "tsv", to: "json" });
    const parsed = JSON.parse((result.data as { result: string }).result) as Array<Record<string, string>>;
    expect(parsed).toEqual([{ a: "1", b: "2" }]);
  });

  it("escapes XML output", () => {
    const result = convertDataTool({ data: '[{"v":"<b>"}]', from: "json", to: "xml", root: "rows" });
    const data = result.data as { result: string };
    expect(data.result).toContain("<rows>");
    expect(data.result).toContain("&lt;b&gt;");
  });

  it("refuses an unparseable JSON input with a readable error", () => {
    const result = convertDataTool({ data: "{not json", from: "json", to: "csv" });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/not valid JSON/);
  });

  it("refuses unknown formats", () => {
    expect((convertDataTool({ data: "[]", from: "yaml", to: "json" }).ok)).toBe(false);
    expect((convertDataTool({ data: "[]", from: "json", to: "yaml" }).ok)).toBe(false);
  });
});

describe("encode_decode", () => {
  it("round-trips base64", () => {
    const encoded = encodeDecodeTool({ operation: "base64-encode", text: "héllo ✅" });
    const decoded = encodeDecodeTool({
      operation: "base64-decode",
      text: (encoded.data as { result: string }).result,
    });
    expect((decoded.data as { result: string }).result).toBe("héllo ✅");
  });

  it("round-trips URL and hex encodings", () => {
    expect((encodeDecodeTool({ operation: "url-encode", text: "a b&c" }).data as { result: string }).result).toBe("a%20b%26c");
    expect((encodeDecodeTool({ operation: "url-decode", text: "a%20b%26c" }).data as { result: string }).result).toBe("a b&c");
    const hex = encodeDecodeTool({ operation: "hex-encode", text: "AB" });
    expect((hex.data as { result: string }).result).toBe("4142");
    const back = encodeDecodeTool({ operation: "hex-decode", text: "4142" });
    expect((back.data as { result: string }).result).toBe("AB");
  });

  it("decodes a JWT payload without verifying it, and says so", () => {
    // header {alg:HS256,typ:JWT} payload {sub:"u1",exp:1770000000} signature "sig"
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsImV4cCI6MTc3MDAwMDAwMH0.c2ln";
    const result = encodeDecodeTool({ operation: "jwt-decode", text: token });
    expect(result.ok).toBe(true);
    const data = result.data as { claims: Record<string, unknown> };
    expect(data.claims.sub).toBe("u1");
    expect(String(data.claims._note)).toMatch(/NOT VERIFIED/i);
    expect(String(data.claims._exp_date)).toBe("2026-02-02T02:40:00.000Z");
  });

  it("refuses a token with no payload section", () => {
    const result = encodeDecodeTool({ operation: "jwt-decode", text: "not-a-jwt" });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/three dot-separated/i);
  });

  it("refuses an unknown operation", () => {
    expect((encodeDecodeTool({ operation: "jwt-sign", text: "x" }).ok)).toBe(false);
  });
});

describe("hash_text", () => {
  it("produces the known SHA-256 digest of a fixed input", async () => {
    const result = await hashTextTool({ text: "hello", algorithm: "SHA-256" });
    expect(result.ok).toBe(true);
    const data = result.data as { hex: string };
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(data.hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns base64 alongside hex", async () => {
    const result = await hashTextTool({ text: "hello" });
    const data = result.data as { base64: string; bytes: number };
    expect(data.base64).toBeTruthy();
    expect(data.bytes).toBe(32);
  });

  it("refuses an unknown algorithm", async () => {
    expect((await hashTextTool({ text: "x", algorithm: "MD5" })).ok).toBe(false);
  });
});

describe("regex_test", () => {
  it("reports every match with an index for a global pattern", () => {
    const result = regexTestTool({ pattern: "\\d+", flags: "g", text: "a1 b22 c333" });
    const data = result.data as { matchCount: number; matches: Array<{ match: string; index: number }> };
    expect(data.matchCount).toBe(3);
    expect(data.matches[1]).toEqual({ match: "22", index: 4 });
  });

  it("reports named and numbered capture groups", () => {
    const result = regexTestTool({ pattern: "(?<year>\\d{4})-(\\d{2})", text: "2026-03" });
    const data = result.data as { matches: Array<{ groups?: Record<string, string>; captureGroups?: string[] }> };
    expect(data.matches[0]!.groups!.year).toBe("2026");
    expect(data.matches[0]!.captureGroups).toEqual(["2026", "03"]);
  });

  it("returns one match for a non-global pattern", () => {
    const result = regexTestTool({ pattern: "\\d", text: "1 2 3" });
    expect((result.data as { matchCount: number }).matchCount).toBe(1);
  });

  it("handles zero-width matches without hanging", () => {
    const result = regexTestTool({ pattern: "x*", flags: "g", text: "abc" });
    expect(result.ok).toBe(true);
    expect((result.data as { matchCount: number }).matchCount).toBe(4);
  });

  it("refuses an invalid pattern with the regex engine's message", () => {
    const result = regexTestTool({ pattern: "([unclosed", text: "x" });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/Invalid pattern/);
  });
});

describe("timestamp_convert", () => {
  it("reads a bare number under 10^11 as seconds and says so", () => {
    const result = timestampConvertTool({ timestamp: "1770000000" });
    expect(result.ok).toBe(true);
    const data = result.data as { interpretedAs: string; iso: string; unixSeconds: number };
    expect(data.interpretedAs).toBe("seconds");
    expect(data.iso).toBe("2026-02-02T02:40:00.000Z");
    expect(data.unixSeconds).toBe(1_770_000_000);
  });

  it("reads a large number as milliseconds", () => {
    const result = timestampConvertTool({ timestamp: 1770000000000 });
    expect((result.data as { interpretedAs: string }).interpretedAs).toBe("milliseconds");
  });

  it("parses an ISO string and reports a relative age", () => {
    const result = timestampConvertTool({ timestamp: "2020-01-01T00:00:00Z" });
    const data = result.data as { interpretedAs: string; relative: string };
    expect(data.interpretedAs).toBe("ISO/text parse");
    expect(data.relative).toMatch(/ago$/);
  });

  it("reports NOW when called with no timestamp (the model cannot see a clock)", () => {
    const result = timestampConvertTool({});
    const data = result.data as { interpretedAs: string; iso: string };
    expect(data.interpretedAs).toMatch(/now/i);
    expect(Number.isNaN(Date.parse(data.iso))).toBe(false);
  });

  it("survives an invalid timezone and an unparseable value", () => {
    const tz = timestampConvertTool({ timestamp: "2026-03-15T12:00:00Z", timeZone: "Mars/Olympus" });
    expect(tz.ok).toBe(true);
    expect((tz.data as { timeZone: string }).timeZone).toBe("UTC");
    expect((timestampConvertTool({ timestamp: "garbage" }).ok)).toBe(false);
  });
});

describe("uuid_generate", () => {
  it("generates the requested count of v4 ids", () => {
    const result = uuidGenerateTool({ format: "v4", count: 5 });
    const data = result.data as { ids: string[] };
    expect(data.ids).toHaveLength(5);
    for (const id of data.ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("generates sortable ULIDs and short ids", () => {
    const ulid = uuidGenerateTool({ format: "ulid", count: 2 });
    const ids = (ulid.data as { ids: string[] }).ids;
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const short = uuidGenerateTool({ format: "short" });
    expect((short.data as { ids: string[] }).ids[0]).toMatch(/^[0-9a-f]{12}$/);
  });

  it("refuses an unknown format and clamps the count", () => {
    expect((uuidGenerateTool({ format: "v5" }).ok)).toBe(false);
    const many = uuidGenerateTool({ format: "v4", count: 500 });
    expect((many.data as { ids: string[] }).ids).toHaveLength(50);
  });
});
