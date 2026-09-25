// ============================================================
// Utility Tools — Pure Conversions, Encodings, Checks
// ============================================================
// The executors for the batch-one utility tools: generate_csv,
// convert_data, encode_decode, hash_text, regex_test,
// timestamp_convert and uuid_generate.
//
// The family rule is the one lib/app-tools.ts states: UI-free and
// store-free, defensive about arguments even though the registry
// validates first (a tool is also reachable through the repair path and
// from tests), and honest in the result about what a green run proves.
// Every executor here is a pure local computation — no network, no
// worker, no workspace — so they are the cheapest tools in the surface
// and the natural first reach when a conversion or a check is the task.
//
// Dependencies: none. Everything runs on the platform (WebCrypto,
// Intl, JSON, RegExp), which is what keeps the tools shippable without
// a bundle-size or supply-chain conversation.

import type { ToolCallResult, ToolName } from "../types";

/** Cap on any one argument's text (keeps a result under the wire budget) */
const MAX_INPUT_CHARS = 500_000;
/** Cap on a returned text payload */
const MAX_OUTPUT_CHARS = 100_000;

function ok(
  name: ToolName,
  data: unknown,
  summary: string,
  started: number
): ToolCallResult {
  return {
    callId: "",
    name,
    ok: true,
    data,
    durationMs: Date.now() - started,
    summary,
  };
}

function fail(
  name: ToolName,
  error: string,
  summary: string,
  started: number
): ToolCallResult {
  return {
    callId: "",
    name,
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary,
  };
}

function clip(text: string): { text: string; clipped: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, clipped: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output clipped at ${MAX_OUTPUT_CHARS} chars]`,
    clipped: true,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Rejects the oversized-input cases with the size named */
function guardInput(
  name: ToolName,
  label: string,
  value: string,
  started: number
): ToolCallResult | null {
  if (value.length > MAX_INPUT_CHARS) {
    return fail(
      name,
      `${label} is ${value.length} characters; the limit is ${MAX_INPUT_CHARS}.`,
      "input too large",
      started
    );
  }
  return null;
}

// ── generate_csv ─────────────────────────────────────────────

type Row = Record<string, unknown>;

function parseRows(input: unknown, name: ToolName, started: number): { rows?: Row[]; error?: ToolCallResult } {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!Array.isArray(parsed)) {
        return { error: fail(name, "`data` must be a JSON ARRAY of objects (or JSON text of one).", "bad data shape", started) };
      }
      return { rows: parsed as Row[] };
    } catch {
      return { error: fail(name, "`data` is not valid JSON text — parse errors cannot be converted.", "bad json", started) };
    }
  }
  if (!Array.isArray(input)) {
    return { error: fail(name, "`data` must be an ARRAY of flat objects.", "bad data shape", started) };
  }
  return { rows: input as Row[] };
}

function csvCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  // RFC 4180: quote when the cell contains the delimiter, a quote, a
  // newline, or leading/trailing whitespace a spreadsheet would trim.
  const needsQuoting =
    text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text) || text !== text.trim();
  const escaped = text.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : text;
}

/**
 * generate_csv — JSON rows to CSV/TSV text. Pure: string in, string out,
 * so the result is applied with write_file and reviewed with the change set.
 */
export function generateCsvTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "generate_csv";
  const parsed = parseRows(args.data, name, started);
  if (parsed.error) return parsed.error;
  const rows = parsed.rows!;

  const format = asString(args.format) || "csv";
  if (format !== "csv" && format !== "tsv") {
    return fail(name, '`format` must be "csv" or "tsv".', "bad format", started);
  }
  const delimiter = format === "tsv" ? "\t" : asString(args.delimiter) || ",";

  const flat: Row[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return fail(name, "Every row must be a flat OBJECT of scalar values.", "bad row", started);
    }
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value === "object") {
        return fail(
          name,
          `Row value "${key}" is an object/array — flatten it first (generate_csv writes flat rows).`,
          "nested row value",
          started
        );
      }
    }
    flat.push(row);
  }
  if (flat.length === 0) {
    return fail(name, "`data` has no rows — nothing to serialize.", "no rows", started);
  }

  // Columns: explicit order when given, otherwise first-seen order.
  const explicit = Array.isArray(args.columns)
    ? args.columns.filter((c): c is string => typeof c === "string")
    : null;
  const columns = explicit ?? [...new Set(flat.flatMap((r) => Object.keys(r)))];
  if (columns.length === 0) {
    return fail(name, "No columns to write — rows have no keys and `columns` is empty.", "no columns", started);
  }

  const lines = [columns.map((c) => csvCell(c, delimiter)).join(delimiter)];
  for (const row of flat) {
    lines.push(columns.map((c) => csvCell(row[c], delimiter)).join(delimiter));
  }
  const { text, clipped } = clip(lines.join("\n"));

  return ok(
    name,
    {
      format,
      rows: flat.length,
      columns: columns.length,
      csv: text,
      ...(clipped ? { note: `Output was clipped at ${MAX_OUTPUT_CHARS} characters — serialize fewer rows.` } : {}),
      note: "Text result — write it to a file with write_file so it is reviewable with the change set.",
    },
    `${flat.length} row(s) → ${format}`,
    started
  );
}

// ── convert_data ─────────────────────────────────────────────

const CONVERT_FORMATS = ["json", "csv", "tsv", "xml"] as const;
type ConvertFormat = (typeof CONVERT_FORMATS)[number];

function parseDelimited(text: string, delimiter: string): Row[] {
  // RFC 4180-aware split: quotes may wrap cells and contain delimiters.
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (text.startsWith(delimiter, i)) {
      row.push(cell);
      cell = "";
      i += delimiter.length - 1;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!header) return [];
  return body.map((r) => {
    const obj: Row = {};
    header.forEach((key, i) => (obj[key.trim()] = r[i] ?? ""));
    return obj;
  });
}

function toXml(rows: Row[], root: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tagName = (key: string) => key.replace(/[^\w.-]/g, "_") || "field";
  const lines = [`<${root}>`];
  for (const row of rows) {
    lines.push("  <row>");
    for (const [key, value] of Object.entries(row)) {
      lines.push(`    <${tagName(key)}>${esc(value === null || value === undefined ? "" : String(value))}</${tagName(key)}>`);
    }
    lines.push("  </row>");
  }
  lines.push(`</${root}>`);
  return lines.join("\n");
}

/**
 * convert_data — JSON ↔ CSV ↔ TSV ↔ XML for row-shaped data.
 * Delimited parsing is RFC 4180-aware (quoted cells, embedded delimiters).
 */
export function convertDataTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "convert_data";
  const from = asString(args.from);
  const to = asString(args.to);
  if (!CONVERT_FORMATS.includes(from as ConvertFormat)) {
    return fail(name, `\`from\` must be one of: ${CONVERT_FORMATS.join(", ")}.`, "bad format", started);
  }
  if (!CONVERT_FORMATS.includes(to as ConvertFormat)) {
    return fail(name, `\`to\` must be one of: ${CONVERT_FORMATS.join(", ")}.`, "bad format", started);
  }

  const text = asString(args.data);
  if (!text.trim()) return fail(name, "`data` is required — the text to convert.", "no data", started);
  const guarded = guardInput(name, "`data`", text, started);
  if (guarded) return guarded;

  // Parse the FROM side into rows.
  let rows: Row[];
  if (from === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(name, "`data` is not valid JSON.", "bad json", started);
    }
    if (Array.isArray(parsed)) {
      rows = parsed as Row[];
    } else if (typeof parsed === "object" && parsed !== null) {
      // A single object is one row (the common API-response case).
      rows = [parsed as Row];
    } else {
      return fail(name, "JSON data must be an object or an array of objects.", "bad json shape", started);
    }
  } else {
    const delimiter = from === "tsv" ? "\t" : asString(args.delimiter) || ",";
    rows = parseDelimited(text, delimiter);
  }
  rows = rows.filter((r) => typeof r === "object" && r !== null && !Array.isArray(r));
  if (rows.length === 0) {
    return fail(name, "No data rows could be parsed from `data`.", "no rows", started);
  }

  // Serialize the TO side.
  let out: string;
  if (to === "json") {
    out = JSON.stringify(rows, null, 2);
  } else if (to === "xml") {
    out = toXml(rows, asString(args.root) || "data");
  } else {
    const delimiter = to === "tsv" ? "\t" : ",";
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    out = [columns.join(delimiter), ...rows.map((r) => columns.map((c) => csvCell(r[c], delimiter)).join(delimiter))].join("\n");
  }
  const { text: clipped, clipped: wasClipped } = clip(out);

  return ok(
    name,
    {
      from,
      to,
      rows: rows.length,
      result: clipped,
      ...(wasClipped ? { note: `Output was clipped at ${MAX_OUTPUT_CHARS} characters.` } : {}),
    },
    `${rows.length} row(s): ${from} → ${to}`,
    started
  );
}

// ── encode_decode ────────────────────────────────────────────

const ENCODE_OPS = ["base64-encode", "base64-decode", "url-encode", "url-decode", "hex-encode", "hex-decode", "jwt-decode"] as const;
type EncodeOp = (typeof ENCODE_OPS)[number];

/** Decodes a JWT's payload WITHOUT verifying it — stated in the result */
function jwtDecode(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("A JWT has three dot-separated sections; this token does not.");
  }
  const decode = (part: string): unknown => {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    return JSON.parse(decodeURIComponent(escape(binary)));
  };
  const payload = decode(parts[1]!);
  const claims: Record<string, unknown> =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : { payload };
  if (parts[2]) {
    claims._note = "SIGNATURE NOT VERIFIED — decoding is not validation; anyone can mint a token.";
  }
  // Exp/iat are unix seconds; surfaces them as dates so the model reads them right.
  for (const key of ["exp", "iat", "nbf"]) {
    if (typeof claims[key] === "number") {
      claims[`_${key}_date`] = new Date((claims[key] as number) * 1000).toISOString();
    }
  }
  return claims;
}

/**
 * encode_decode — the encodings models are asked for by hand: base64,
 * URL, hex, and JWT *decoding* (never signing or verifying).
 */
export function encodeDecodeTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "encode_decode";
  const op = asString(args.operation);
  if (!ENCODE_OPS.includes(op as EncodeOp)) {
    return fail(name, `\`operation\` must be one of: ${ENCODE_OPS.join(", ")}.`, "bad operation", started);
  }
  const text = asString(args.text);
  if (!text) return fail(name, "`text` is required.", "no text", started);
  const guarded = guardInput(name, "`text`", text, started);
  if (guarded) return guarded;

  try {
    let result: string;
    switch (op) {
      case "base64-encode":
        result = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
        break;
      case "base64-decode": {
        const binary = atob(text.replace(/\s+/g, ""));
        result = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
        break;
      }
      case "url-encode":
        result = encodeURIComponent(text);
        break;
      case "url-decode":
        result = decodeURIComponent(text);
        break;
      case "hex-encode":
        result = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
        break;
      case "hex-decode":
        result = new TextDecoder().decode(
          Uint8Array.from((text.replace(/\s+/g, "").match(/../g) ?? []).map((byte) => parseInt(byte, 16)))
        );
        break;
      case "jwt-decode": {
        const claims = jwtDecode(text);
        return ok(name, { operation: op, claims, payload: JSON.stringify(claims, null, 2) }, "JWT decoded (unverified)", started);
      }
    }
    const { text: clipped, clipped: wasClipped } = clip(result);
    return ok(
      name,
      { operation: op, result: clipped, ...(wasClipped ? { note: "Output clipped." } : {}) },
      `${op} (${result.length} chars)`,
      started
    );
  } catch (err) {
    return fail(
      name,
      `${op} failed: ${err instanceof Error ? err.message : "invalid input for this operation"}.`,
      "encode/decode failed",
      started
    );
  }
}

// ── hash_text ────────────────────────────────────────────────

const HASH_ALGOS = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const;

/**
 * hash_text — SHA digests via WebCrypto. Returns hex and base64.
 */
export async function hashTextTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const started = Date.now();
  const name = "hash_text";
  const algorithm = asString(args.algorithm) || "SHA-256";
  const upper = algorithm.toUpperCase();
  if (!HASH_ALGOS.includes(upper as (typeof HASH_ALGOS)[number])) {
    return fail(name, `\`algorithm\` must be one of: ${HASH_ALGOS.join(", ")}.`, "bad algorithm", started);
  }
  const text = asString(args.text);
  if (!text) return fail(name, "`text` is required — the text to hash.", "no text", started);
  const guarded = guardInput(name, "`text`", text, started);
  if (guarded) return guarded;

  const digest = await crypto.subtle.digest(upper, new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  let base64 = "";
  for (let i = 0; i < bytes.length; i += 3) {
    base64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 3))).padEnd(4, "=");
  }
  return ok(
    name,
    { algorithm: upper, hex, base64, bytes: bytes.length },
    `${upper} of ${text.length} char(s)`,
    started
  );
}

// ── regex_test ───────────────────────────────────────────────

/**
 * regex_test — runs a pattern against sample text and reports named
 * matches. Cheaper and more precise than a whole run_code round for
 * "does this regex do what I think".
 */
export function regexTestTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "regex_test";
  const pattern = asString(args.pattern);
  const flagsInput = asString(args.flags);
  const text = asString(args.text);
  if (!pattern) return fail(name, "`pattern` is required — the regular expression body.", "no pattern", started);
  if (!text) return fail(name, "`text` is required — the sample to run against.", "no text", started);
  const guarded = guardInput(name, "`text`", text, started);
  if (guarded) return guarded;

  const allowed = new Set(["g", "i", "m", "s", "u"]);
  const flags = [...new Set(flagsInput.split("").filter((f) => allowed.has(f)))].join("");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    return fail(
      name,
      `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`,
      "bad regex",
      started
    );
  }

  const MAX_MATCHES = 200;
  const matches: Array<{ index: number; match: string; groups?: Record<string, string>; captureGroups?: string[] }> = [];
  const global = flags.includes("g");
  const scanner = new RegExp(regex.source, flags.includes("g") ? flags : `${flags}g`);
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(text)) !== null) {
    const entry: (typeof matches)[number] = { index: m.index, match: m[0] };
    if (m.groups && Object.keys(m.groups).length > 0) entry.groups = m.groups;
    if (m.length > 1) entry.captureGroups = m.slice(1).map((g) => g ?? "");
    matches.push(entry);
    if (m[0] === "") scanner.lastIndex++;
    if (matches.length >= MAX_MATCHES) break;
  }
  // A non-global pattern reports the first match as its answer.
  if (!global && matches.length > 0) matches.splice(1);

  const { text: clipped, clipped: wasClipped } = clip(text);
  return ok(
    name,
    {
      pattern,
      flags,
      matchCount: matches.length,
      matches: matches.slice(0, 50),
      sample: clipped,
      ...(matches.length >= MAX_MATCHES ? { note: `Stopped at ${MAX_MATCHES} matches.` } : {}),
      ...(wasClipped ? { note: "Sample text was clipped in the result." } : {}),
    },
    `${matches.length} match(es)`,
    started
  );
}

// ── timestamp_convert ────────────────────────────────────────

/**
 * timestamp_convert — unix ↔ ISO ↔ readable, timezone-aware.
 * Bare numbers are unix SECONDS under 10^11, milliseconds above (the
 * heuristic every epoch converter uses); the result says which it chose.
 */
export function timestampConvertTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "timestamp_convert";
  const value = args.timestamp;
  const timeZone = asString(args.timeZone) || "UTC";
  let date: Date;
  let interpretedAs: string;

  if (typeof value === "number" && Number.isFinite(value)) {
    interpretedAs = Math.abs(value) >= 1e11 ? "milliseconds" : "seconds";
    date = new Date(interpretedAs === "seconds" ? value * 1000 : value);
  } else if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      interpretedAs = Math.abs(n) >= 1e11 ? "milliseconds" : "seconds";
      date = new Date(interpretedAs === "seconds" ? n * 1000 : n);
    } else {
      interpretedAs = "ISO/text parse";
      date = new Date(trimmed);
    }
  } else if (value === undefined || value === null || value === "") {
    interpretedAs = "now (no timestamp given)";
    date = new Date();
  } else {
    return fail(name, "`timestamp` must be a number, a numeric string, or an ISO date string.", "bad timestamp", started);
  }
  if (Number.isNaN(date.getTime())) {
    return fail(name, "Could not parse `timestamp` as a date.", "unparseable", started);
  }

  let tzValid = true;
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(date);
  } catch {
    tzValid = false;
    local = "invalid timeZone — reporting UTC";
  }

  return ok(
    name,
    {
      interpretedAs,
      iso: date.toISOString(),
      unixSeconds: Math.floor(date.getTime() / 1000),
      unixMilliseconds: date.getTime(),
      timeZone: tzValid ? timeZone : "UTC",
      local,
      relative: relativeAge(date),
    },
    date.toISOString(),
    started
  );
}

function relativeAge(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const units: Array<[number, string]> = [
    [1000, "second"],
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
    [2_592_000_000, "month"],
    [31_536_000_000, "year"],
  ];
  let unit = units[0]!;
  for (const u of units) if (abs >= u[0]) unit = u;
  const value = Math.round(abs / unit[0]);
  const direction = diffMs >= 0 ? "in the future" : "ago";
  return `${value} ${unit[1]}${value === 1 ? "" : "s"} ${direction}`;
}

// ── uuid_generate ────────────────────────────────────────────

const UUID_FORMATS = ["v4", "ulid", "short"] as const;

function ulid(at: number): string {
  // Crockford base32, 10 chars of time + 16 of randomness.
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let t = at;
  for (let i = 0; i < 10; i++) {
    time = ENCODING[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let random = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let carry = 0;
  // 80 random bits → 16 base32 chars.
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      random += ENCODING[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  void carry;
  return `${time}${random}`;
}

/**
 * uuid_generate — v4 identifiers, monotonic-ish ULIDs, short ids.
 * Nothing here is a security token generator for auth (v4 from
 * crypto.getRandomValues is, and the result says so).
 */
export function uuidGenerateTool(args: Record<string, unknown>): ToolCallResult {
  const started = Date.now();
  const name = "uuid_generate";
  const format = asString(args.format) || "v4";
  if (!UUID_FORMATS.includes(format as (typeof UUID_FORMATS)[number])) {
    return fail(name, `\`format\` must be one of: ${UUID_FORMATS.join(", ")}.`, "bad format", started);
  }
  const count = Math.min(Math.max(typeof args.count === "number" ? Math.floor(args.count) : 1, 1), 50);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    if (format === "v4") {
      ids.push(crypto.randomUUID());
    } else if (format === "ulid") {
      ids.push(ulid(Date.now()));
    } else {
      ids.push(crypto.randomUUID().replace(/-/g, "").slice(0, 12));
    }
  }
  return ok(
    name,
    {
      format,
      count: ids.length,
      ids,
      note:
        format === "v4"
          ? "Cryptographically random (crypto.getRandomValues) — safe as an identifier."
          : format === "ulid"
            ? "Lexicographically sortable: the first 10 characters encode the millisecond timestamp."
            : "Short id — 12 hex characters, fine for display keys, NOT for security.",
    },
    `${ids.length} ${format} id(s)`,
    started
  );
}
