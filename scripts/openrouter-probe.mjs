#!/usr/bin/env node
// ============================================================
// OpenRouter Probe — Do The Fields We Parse Still Exist?
// ============================================================
// Every parser in lib/openrouter-* and lib/model-* is written against a shape
// that somebody read once. When OpenRouter changes that shape, the parser does
// not throw: a missing `input_cache_read` reads as "this model has no cache
// pricing", a missing `agentic_index` reads as "no published score", and a
// renamed error field reads as "unknown failure". Silent degradation is the
// failure mode this script exists to prevent.
//
// So the field list lives here, next to the reason each field is load-bearing,
// and this script answers one question in a minute: does the live API still
// look like the API our parsers were written against?
//
//   npm run probe:openrouter              # verify, exit 1 on any missing field
//   npm run probe:openrouter -- --fixtures   # also refresh the test fixtures
//
// It reads OPENROUTER_API_KEY from the environment. Locally:
//
//   echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> .env.local && npm run probe:openrouter
//
// READ-ONLY BY DESIGN. Everything here is a GET, plus two deliberately-invalid
// requests that cost nothing and exist to capture real error envelopes. It
// never runs a completion, so it never spends credits and never touches the
// account's 50 free requests/day.
//
// The fixtures written by --fixtures are what makes the unit tests real: a test
// that parses a fixture captured from the live API fails when the API changes,
// while a test that parses a hand-written object only proves the parser agrees
// with its author.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "src/features/chat/lib/__fixtures__");
const BASE = "https://openrouter.ai/api/v1";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const wantFixtures = process.argv.includes("--fixtures");

if (!apiKey) {
  console.error(
    "OPENROUTER_API_KEY is not set.\n" +
      "Add it to .env.local (gitignored) and re-run with:\n" +
      "  node --env-file-if-exists=.env.local scripts/openrouter-probe.mjs"
  );
  process.exit(2);
}

let failures = 0;

async function get(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __unparsed: text.slice(0, 200) };
  }
  return { status: res.status, headers: res.headers, json };
}

/** Reports each required field, so a failure names the field and not the file. */
function check(label, object, fields) {
  const missing = fields.filter((f) => object?.[f] === undefined);
  if (missing.length > 0) {
    failures += 1;
    console.error(`  ✗ ${label} — MISSING: ${missing.join(", ")}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
  return missing;
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Builds a model path WITHOUT encoding the separators.
 *
 * `/model/{author}/{slug}` and `/models/{author}/{slug}/endpoints` are path
 * routes, not query parameters: the slash IS the structure. `encodeURIComponent`
 * turns `openai/gpt-6-luna-pro` into `openai%2Fgpt-6-luna-pro`, the route stops
 * matching, and the lookup silently returns an empty endpoint list or a 404
 * instead of an error — which is exactly how a picker ends up offering models
 * that cannot be routed. `encodeURI` leaves `/` and `:` in place, which is what
 * a path wants; the `:` matters because variant suffixes ride on it.
 */
function modelPath(id) {
  return encodeURI(id);
}

/** Trims a record to the keys we parse, keeping the fixture reviewable. */
function pick(object, keys) {
  const out = {};
  for (const k of keys) if (object?.[k] !== undefined) out[k] = object[k];
  return out;
}

async function writeFixture(name, data) {
  await mkdir(FIXTURES, { recursive: true });
  const path = join(FIXTURES, name);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`  → fixtures/${name}`);
}

// ── 1. Key and credits ───────────────────────────────────────
// The app shows credits and the free-model daily quota in settings; both come
// from this one call.

section("GET /key");
const key = await get("/key");
const keyData = key.json?.data;

/**
 * A rejected credential is NOT an API-shape finding.
 *
 * Without this check, every authenticated section below reports its fields as
 * MISSING — which is precisely what a real regression looks like — so a revoked
 * or unpaid key sends the reader hunting through three parser files for a change
 * that never happened. It is counted once, named as what it is, and the
 * authenticated checks are skipped rather than run against a 401 body.
 */
const keyRejected = key.status === 401 || key.status === 403;
if (keyRejected) {
  failures += 1;
  console.error(
    `  ✗ credential rejected — HTTP ${key.status}: ${key.json?.error?.message ?? "no message"}`
  );
  console.error(
    "    /key, /benchmarks and the validation check all need a working key, so they\n" +
      "    were skipped: run against a rejected key, they report missing fields that are\n" +
      "    present. The public endpoints are still checked below. Re-run with a valid key:\n" +
      "      OPENROUTER_API_KEY=… node scripts/openrouter-probe.mjs --fixtures"
  );
} else {
  check("/key data", keyData, [
    "label",
    "limit",
    "limit_remaining",
    "usage",
    "is_free_tier",
    "free_model_daily_requests",
  ]);
  if (keyData?.free_model_daily_requests) {
    check("free_model_daily_requests", keyData.free_model_daily_requests, [
      "used",
      "limit",
      "remaining",
    ]);
  }
  if (keyData) {
    console.log(
      `    free tier=${keyData.is_free_tier} ` +
        `free-model quota=${keyData.free_model_daily_requests?.remaining ?? "?"}/` +
        `${keyData.free_model_daily_requests?.limit ?? "?"} per day`
    );
  }
}

// ── 2. The catalog ───────────────────────────────────────────
// Every field below is one the app either already reads or is about to:
//   pricing.input_cache_read/write  → the cache-savings line in the cost meter
//   pricing.overrides               → the long-context / peak-hour cost warning
//   canonical_slug                  → the benchmark join key (differs from `id`)
//   reasoning.*                     → the effort control and its defaults
//   top_provider.max_completion_tokens → the real ceiling for max_tokens
//   benchmarks.design_arena         → a picker sort axis
//   expiration_date                 → the "deprecated" badge

section("GET /models");
const models = await get("/models?limit=1000");
check("/models envelope", models.json, ["data", "total_count"]);
const all = models.json?.data ?? [];
const sample = all[0] ?? {};
check("model record", sample, [
  "id",
  "name",
  "context_length",
  "pricing",
  "supported_parameters",
  "architecture",
]);
check("pricing", sample.pricing, ["prompt", "completion"]);
// Nullable by contract (many models have no explicit cache pricing), so these
// are counted rather than required.
const count = (pred) => all.filter(pred).length;
const stats = {
  models: all.length,
  withTools: count((m) => (m.supported_parameters ?? []).includes("tools")),
  withStructuredOutputs: count((m) =>
    (m.supported_parameters ?? []).includes("structured_outputs")
  ),
  withCacheReadPrice: count((m) => (m.pricing ?? {}).input_cache_read != null),
  withCacheWritePrice: count((m) => (m.pricing ?? {}).input_cache_write != null),
  withPriceOverrides: count((m) => ((m.pricing ?? {}).overrides ?? []).length > 0),
  withDesignArena: count((m) => ((m.benchmarks ?? {}).design_arena ?? []).length > 0),
  withReasoning: count((m) => m.reasoning != null),
  withSupportedEfforts: count((m) => (m.reasoning ?? {}).supported_efforts != null),
  withMaxTokensReasoning: count((m) => (m.reasoning ?? {}).supports_max_tokens === true),
  canonicalDiffers: count((m) => m.canonical_slug && m.canonical_slug !== m.id),
  expiring: count((m) => m.expiration_date != null),
  free: count((m) => String(m.id).endsWith(":free")),
  lastPage: models.json?.links?.next == null,
};
console.log(`    ${JSON.stringify(stats)}`);

// A model that declares a max-completion ceiling, so the fixture exercises it.
const richModel =
  all.find((m) => (m.pricing ?? {}).overrides?.length > 0) ??
  all.find((m) => m.top_provider?.max_completion_tokens) ??
  sample;

// ── 3. Benchmark scores ──────────────────────────────────────
// The competence signal escalation stops guessing at. `model_permaslug` (not
// `id`) is the join key, and it carries a date suffix the catalog's `id` does
// not — hence lib/model-benchmarks' normalizer.

section("GET /benchmarks");
const benchmarks = {};
let orRows = [];
if (keyRejected) {
  console.log("  skipped — the credential was rejected (see GET /key above)");
} else {
  const benchSpecs = [
    ["/benchmarks?task_type=agentic&max_results=25", "agentic", ["intelligence_index", "coding_index", "agentic_index"]],
    ["/benchmarks?task_type=coding&max_results=25", "coding", ["coding_index"]],
  ];
  for (const [path, taskType, scoreFields] of benchSpecs) {
    const res = await get(path);
    const rows = res.json?.data ?? [];
    console.log(`  ${path} → ${rows.length} rows`);
    check(`benchmarks[${taskType}] meta`, res.json?.meta, ["as_of", "model_count", "task_type"]);
    check(`benchmarks[${taskType}] row`, rows[0], ["source", "model_permaslug", "display_name", ...scoreFields]);
    benchmarks[taskType] = res.json;
  }

  const orBench = await get("/benchmarks?source=openrouter&max_results=25");
  orRows = orBench.json?.data ?? [];
  check("benchmarks[openrouter] row", orRows[0], [
    "benchmark_type",
    "accuracy",
    "avg_cost_per_task",
    "total_tasks",
    "model_permaslug",
  ]);
  benchmarks.openrouter = { data: orRows, meta: orBench.json?.meta };
  console.log(
    `  cost-per-task spread: ${
      orRows.length
        ? `${Math.min(...orRows.map((r) => r.avg_cost_per_task ?? 0)).toFixed(4)} … ` +
          `${Math.max(...orRows.map((r) => r.avg_cost_per_task ?? 0)).toFixed(4)}`
        : "no rows"
    }`
  );
}

// ── 4. Provider endpoints ────────────────────────────────────
// Per-provider facts: which quantizations exist, whether an endpoint caches
// implicitly (the difference between the cache work landing and silently not),
// and measured uptime/throughput.

section("GET /models/{id}/endpoints");
const epModel = richModel?.id ?? "openai/gpt-4o";
const endpoints = await get(`/models/${modelPath(epModel)}/endpoints`);
const epList = endpoints.json?.data?.endpoints ?? [];
console.log(`  ${epModel} → ${epList.length} endpoints`);
check("endpoint record", epList[0], [
  "name",
  "tag",
  "provider_name",
  "quantization",
  "context_length",
  "max_completion_tokens",
  "supports_implicit_caching",
  "supported_parameters",
  "pricing",
  "status",
  "uptime_last_30m",
]);
check("endpoint pricing", epList[0]?.pricing, ["prompt", "completion"]);

// ── 5. The picker's variant rule ─────────────────────────────
// Routing variants are not catalog entries, so the picker has to derive them.
// Verified behaviour: a routing variant resolves to the BASE entry, a catalog
// variant to its own, and a nonexistent catalog variant to an empty endpoint
// list (not an error) — which is how the picker avoids offering dead ids.

section("variant resolution");
const base = richModel?.id;
const nitro = await get(`/model/${modelPath(base)}:nitro`);
check(`/model/{id}:nitro data`, nitro.json?.data, ["id"]);
if (nitro.json?.data?.id !== base) {
  failures += 1;
  console.error(`  ✗ :nitro should resolve to the base entry, got ${nitro.json?.data?.id}`);
} else {
  console.log(`  ✓ :nitro resolves to ${base}`);
}
// Observed 2026-09-24: a catalog variant the model does not have answers 404,
// not the 200-with-empty-endpoints the docs describe. The picker rule has to
// treat both as "this variant does not exist" rather than only the empty list.
const noFree = await get(`/models/${modelPath(base)}:free/endpoints`);
const noFreeCount = (noFree.json?.data?.endpoints ?? []).length;
if (noFree.status === 404 || (noFree.status === 200 && noFreeCount === 0)) {
  console.log(`  ✓ absent :free variant is detectable (status=${noFree.status}, count=${noFreeCount})`);
} else {
  failures += 1;
  console.error(`  ✗ absent :free variant gave an unexpected answer: ${noFree.status}`);
}

// ── 6. Error envelopes (free: no valid inference request is made) ──
// The taxonomy in lib/openrouter-error-taxonomy parses these. Two probes, both
// free: a bad key, and a request that fails validation before inference.

section("error envelopes");
const badKey = await fetch(`${BASE}/key`, { headers: { Authorization: "Bearer sk-or-v1-invalid-probe-key" } });
const badKeyJson = await badKey.json().catch(() => ({}));
check("401 envelope", badKeyJson, ["error"]);
check("401 error body", badKeyJson.error, ["message"]);

// With a rejected key this returns 401 before validation ever runs, so the
// envelope it produces is the auth one and "checking" it here would report the
// 400 shape as changed. The fixture already holds the real 400, captured on a run
// where a working key made the call possible.
let badBody = { status: 0, json: {} };
if (keyRejected) {
  console.log("  POST /chat/completions validation — skipped (credential rejected)");
} else {
  badBody = await get("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  console.log(`  POST /chat/completions without a model → HTTP ${badBody.status}`);
  check("400 envelope", badBody.json, ["error"]);
  check("400 error body", badBody.json.error, ["message"]);
}

const missing = await get("/model/definitely/not-a-real-model");
console.log(`  GET /model/definitely/not-a-real-model → HTTP ${missing.status}`);
check("404 envelope", missing.json, ["error"]);

// ── Fixtures ─────────────────────────────────────────────────
if (wantFixtures) {
  section("writing fixtures");
  const modelKeys = [
    "id", "canonical_slug", "name", "context_length", "pricing", "top_provider",
    "supported_parameters", "architecture", "reasoning", "benchmarks", "expiration_date",
  ];
  // A handful of real models, chosen for shape coverage rather than popularity:
  // one with price overrides, the probe target, and two ordinary records.
  const chosen = [];
  for (const m of [richModel, all[0], all[1], all[2]]) {
    if (m && !chosen.some((c) => c.id === m.id)) chosen.push(pick(m, modelKeys));
  }
  await writeFixture("models-page.json", {
    data: chosen,
    total_count: models.json?.total_count,
    links: models.json?.links ?? { next: null },
  });
  // Fixtures are captured from live responses, so they are only rewritten when
  // the authenticated checks actually ran. Otherwise a rejected key would replace
  // captured benchmark rows with an empty list and quietly weaken the tests that
  // depend on them.
  if (!keyRejected) {
    await writeFixture("benchmarks-agentic.json", {
      data: (benchmarks.agentic.data ?? []).slice(0, 12),
      meta: benchmarks.agentic.meta,
    });
    await writeFixture("benchmarks-coding.json", {
      data: (benchmarks.coding.data ?? []).slice(0, 12),
      meta: benchmarks.coding.meta,
    });
    await writeFixture("benchmarks-openrouter.json", {
      data: orRows.slice(0, 12),
      meta: benchmarks.openrouter.meta,
    });
  }
  await writeFixture("endpoints.json", {
    data: { id: epModel, endpoints: epList.slice(0, 5) },
  });
  await writeFixture("errors.json", {
    unauthorized: badKeyJson,
    ...(badBody.status === 400 ? { badRequest: badBody.json } : {}),
    notFound: missing.json,
  });
}

// ── Verdict ──────────────────────────────────────────────────
console.log("");
if (keyRejected && failures <= 1) {
  // One failure, and it is the credential: nothing here is evidence about the
  // API. Stated as its own verdict so it cannot be read as a shape regression.
  console.error(
    "PROBE INCONCLUSIVE — the credential was rejected, so the authenticated " +
      "sections could not be checked. Nothing about the API shape can be concluded " +
      "from this run; replace the key and try again."
  );
  process.exit(3);
}
if (failures > 0) {
  console.error(
    `PROBE FAILED — ${failures} field check(s) missing. The parsers in ` +
      `lib/model-benchmarks.ts, lib/openrouter-error-taxonomy.ts and ` +
      `lib/model-catalog.ts read these fields; update them before trusting a result.`
  );
  process.exit(1);
}
console.log("PROBE PASSED — every field the app parses is still present.");
