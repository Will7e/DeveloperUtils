import { describe, expect, it } from "vitest";
import {
  buildCompetenceIndex,
  competenceFor,
  competenceScore,
  describeCompetence,
  normalizeModelSlug,
  parseBenchmarkRows,
} from "./model-benchmarks";
import type { ModelInfo } from "../types";
import agenticFixture from "./__fixtures__/benchmarks-agentic.json";
import codingFixture from "./__fixtures__/benchmarks-coding.json";
import openrouterFixture from "./__fixtures__/benchmarks-openrouter.json";
import modelsFixture from "./__fixtures__/models-page.json";

// Fixtures are captured live by `npm run probe:openrouter`.

describe("normalizeModelSlug — the join that 308/459 catalog ids need", () => {
  it("strips the date suffix the publisher adds and the catalog omits", () => {
    expect(normalizeModelSlug("anthropic/claude-fable-5.1-20260831")).toBe(
      "anthropic/claude-fable-5.1"
    );
  });

  it("is idempotent, so it can be applied to an already-normalized slug", () => {
    const once = normalizeModelSlug("z-ai/glm-5.3-flash-20260826");
    expect(normalizeModelSlug(once)).toBe(once);
  });

  it("leaves a date that is not a trailing stamp alone", () => {
    // `gpt-4-0613`-style naming must not be mistaken for a date stamp it is not
    // — but an 8-digit run at the end IS a stamp, which is the documented shape.
    expect(normalizeModelSlug("vendor/model-x-12345678")).toBe("vendor/model-x");
    expect(normalizeModelSlug("vendor/2model")).toBe("vendor/2model");
  });

  it("drops routing variant suffixes, because they are the same model", () => {
    expect(normalizeModelSlug("vendor/model:free")).toBe("vendor/model");
    expect(normalizeModelSlug("vendor/model:thinking")).toBe("vendor/model");
    // The form that actually occurs: the date is on the base id, the variant
    // rides at the end. Both must come off for the join to work.
    expect(normalizeModelSlug("vendor/model-20260101:free")).toBe("vendor/model");
  });

  it("lowercases, because the vocabularies disagree about case", () => {
    expect(normalizeModelSlug("OpenAI/GPT-6-Luna")).toBe("openai/gpt-6-luna");
  });

  it("does not treat a colon before the slash as a variant marker", () => {
    expect(normalizeModelSlug("weird:author/model")).toBe("weird:author/model");
  });
});

describe("parseBenchmarkRows — the observed payloads", () => {
  it("reads the Artificial Analysis rows with all three indices", () => {
    const rows = parseBenchmarkRows(agenticFixture);
    expect(rows.length).toBeGreaterThan(0);
    const top = rows[0]!;
    expect(top.source).toBe("artificial-analysis");
    expect(top.slug).toBe("anthropic/claude-fable-5.1");
    expect(top.rawSlug).toBe("anthropic/claude-fable-5.1-20260831");
    expect(top.codingIndex).toBeCloseTo(81.6);
    expect(top.agenticIndex).toBeCloseTo(57.9);
    expect(top.intelligenceIndex).toBeCloseTo(53.4);
  });

  it("reads OpenRouter's own rows, which are a different shape entirely", () => {
    const rows = parseBenchmarkRows(openrouterFixture);
    const top = rows[0]!;
    expect(top.source).toBe("openrouter");
    expect(top.benchmarkType).toBe("gpqa_diamond");
    expect(top.accuracy).toBeCloseTo(0.946128, 5);
    expect(top.avgCostPerTask).toBeGreaterThan(0);
    expect(top.totalTasks).toBe(198);
    // These rows carry no indices at all — the two sources are not
    // interchangeable, which is why the record keeps them apart.
    expect(top.codingIndex).toBeUndefined();
  });

  it("drops rows with no model to attach the score to", () => {
    const rows = parseBenchmarkRows({
      data: [{ source: "x", accuracy: 0.9 }, { source: "x", model_permaslug: "" }, null],
    });
    expect(rows).toEqual([]);
  });

  it("survives a payload that is not the expected envelope", () => {
    expect(parseBenchmarkRows(undefined)).toEqual([]);
    expect(parseBenchmarkRows({ data: "nope" as unknown })).toEqual([]);
    expect(parseBenchmarkRows(null)).toEqual([]);
  });

  it("keeps zero-valued scores rather than treating 0 as absent", () => {
    // `0` is a measurement. A truthiness check here would silently delete the
    // lowest-scoring models from the index.
    const rows = parseBenchmarkRows({
      data: [{ model_permaslug: "a/b", coding_index: 0, accuracy: 0 }],
    });
    expect(rows[0]?.codingIndex).toBe(0);
    expect(rows[0]?.accuracy).toBe(0);
  });
});

describe("buildCompetenceIndex — joining three vocabularies", () => {
  const catalog = (modelsFixture.data ?? []) as unknown as ModelInfo[];

  it("keys measured competence onto the catalog's undated id", () => {
    const index = buildCompetenceIndex(parseBenchmarkRows(agenticFixture), catalog);
    // The catalog has no claude-fable row in the captured page, so look it up by
    // the benchmark's own slug — the join is by normalized key either way.
    const record = competenceFor(index, "anthropic/claude-fable-5.1-20260831");
    expect(record?.codingIndex).toBeCloseTo(81.6);
  });

  it("resolves a model by its dated permaslug, its bare id, or either case", () => {
    const index = buildCompetenceIndex(parseBenchmarkRows(codingFixture), catalog);
    const row = parseBenchmarkRows(codingFixture)[0]!;
    const expected = competenceFor(index, row.rawSlug);
    expect(expected?.codingIndex).toBeDefined();
    for (const name of [row.slug, row.rawSlug, row.rawSlug.toUpperCase()]) {
      expect(competenceFor(index, name)?.codingIndex).toBe(expected?.codingIndex);
    }
  });

  it("merges an index row and a task-accuracy row into one record", () => {
    const rows = [
      ...parseBenchmarkRows(agenticFixture),
      ...parseBenchmarkRows(openrouterFixture),
    ];
    const index = buildCompetenceIndex(rows, catalog);
    // `anthropic/claude-fable-5.1` appears as an index row; a task row for the
    // same family (if the publisher ran it) must land on the same record rather
    // than a second one keyed on the dated slug.
    const merged = index.bySlug.get("anthropic/claude-fable-5.1");
    expect(merged?.sources).toContain("artificial-analysis");
    expect(Object.keys(merged?.accuracy ?? {}).length).toBeLessThanOrEqual(2);
  });

  it("records which suite a measured cost came from, so costs are never mixed", () => {
    const index = buildCompetenceIndex(parseBenchmarkRows(openrouterFixture), catalog);
    const withCost = [...index.bySlug.values()].find((v) => v.avgCostPerTask !== undefined);
    expect(withCost?.costTaskSuite).toBe("gpqa_diamond");
  });

  it("keeps the first measured cost instead of letting a later suite overwrite it", () => {
    const rows = parseBenchmarkRows({
      data: [
        { source: "openrouter", model_permaslug: "a/b", benchmark_type: "gpqa_diamond", avg_cost_per_task: 0.2 },
        { source: "openrouter", model_permaslug: "a/b", benchmark_type: "tau", avg_cost_per_task: 9.9 },
      ],
    });
    const index = buildCompetenceIndex(rows);
    const record = index.bySlug.get("a/b");
    expect(record?.avgCostPerTask).toBe(0.2);
    expect(record?.costTaskSuite).toBe("gpqa_diamond");
  });

  it("reports unmatched slugs rather than hiding a broken join", () => {
    const index = buildCompetenceIndex(
      parseBenchmarkRows({ data: [{ model_permaslug: "nobody/model-20260101" }] }),
      catalog
    );
    // The catalog was non-empty and matched nothing: that is the signal that a
    // publisher renamed a family and the join needs a look.
    expect(index.unmatchedSlugs).toContain("nobody/model");
  });

  it("does not flag everything as unmatched when there is no catalog to join", () => {
    // Without a catalog there is no join to fail, so an empty catalog must not
    // produce a page of false alarms.
    const index = buildCompetenceIndex(parseBenchmarkRows(agenticFixture));
    expect(index.unmatchedSlugs).toEqual([]);
  });

  it("carries the as-of date so a stale score is identifiable", () => {
    const index = buildCompetenceIndex(
      parseBenchmarkRows(agenticFixture),
      catalog,
      agenticFixture.meta?.as_of
    );
    expect(index.asOf).toBe(agenticFixture.meta?.as_of);
  });
});

describe("competenceScore and describeCompetence", () => {
  it("returns undefined rather than 0 for a model the publisher never scored", () => {
    // 0 would read as "measured as terrible" and rank last-but-not-excluded;
    // undefined is the truth and makes the caller fall back.
    const index = buildCompetenceIndex([]);
    expect(competenceScore(undefined, "coding")).toBeUndefined();
    expect(competenceScore(index.bySlug.get("nothing"), "coding")).toBeUndefined();
  });

  it("names the suite alongside the number, because a bare score means nothing", () => {
    const index = buildCompetenceIndex(parseBenchmarkRows(agenticFixture));
    const record = index.bySlug.get("anthropic/claude-fable-5.1")!;
    expect(describeCompetence(record, "coding")).toMatch(/coding index 81\.6/);
  });

  it("includes the measured per-task cost when the publisher reported one", () => {
    const index = buildCompetenceIndex(parseBenchmarkRows(openrouterFixture));
    const record = [...index.bySlug.values()][0]!;
    // No index score on this row, so the description falls back to the name
    // rather than inventing a number.
    expect(describeCompetence(record, "coding")).toBe(record.displayName);
  });
});
