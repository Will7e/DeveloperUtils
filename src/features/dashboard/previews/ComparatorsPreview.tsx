import { useRef, useState } from "react";
import { Filter, CheckCircle2, AlertCircle, XCircle } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

interface KeyComparison {
  key: string;
  prodVal: string;
  stgVal: string;
  /** Empty when the key is absent from the staging environment. */
  status: "match" | "diff" | "missing";
}

const COMPARISON_DATA: KeyComparison[] = [
  { key: "DB_PORT", prodVal: "5432", stgVal: "5432", status: "match" },
  { key: "API_KEY", prodVal: "prod_live_8a", stgVal: "stg_test_2b", status: "diff" },
  { key: "REDIS_HOST", prodVal: "redis-prod.internal", stgVal: "", status: "missing" },
  { key: "LOG_LEVEL", prodVal: "warn", stgVal: "debug", status: "diff" },
];

const STATUS_LABEL: Record<KeyComparison["status"], string> = {
  match: "Equal",
  diff: "Mismatch",
  missing: "Missing",
};

/** Builds two .env files so the real comparator opens with the demo's data. */
function toEnvFile(rows: KeyComparison[], side: "prod" | "stg"): string {
  return rows
    .filter((row) => side === "prod" || row.stgVal !== "")
    .map((row) => `${row.key}=${side === "prod" ? row.prodVal : row.stgVal}`)
    .join("\n");
}

export function ComparatorsPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<"diffs" | "all">("diffs");

  const displayedData =
    filter === "diffs"
      ? COMPARISON_DATA.filter((d) => d.status !== "match")
      : COMPARISON_DATA;

  const counts = {
    match: COMPARISON_DATA.filter((d) => d.status === "match").length,
    diff: COMPARISON_DATA.filter((d) => d.status === "diff").length,
    missing: COMPARISON_DATA.filter((d) => d.status === "missing").length,
  };

  const steps: AutopilotStep[] = [
    {
      target: '[data-filter="all"]',
      fallback: { x: 58, y: 12 },
      action: "Show every key",
      hover: "filter-all",
      run: () => setFilter("all"),
    },
    {
      target: '[data-row="API_KEY"]',
      fallback: { x: 45, y: 45 },
      action: "Values differ",
      transition: 600,
    },
    {
      target: '[data-filter="diffs"]',
      fallback: { x: 40, y: 12 },
      action: "Only what changed",
      hover: "filter-diffs",
      run: () => setFilter("diffs"),
    },
    {
      target: '[data-row="REDIS_HOST"]',
      fallback: { x: 45, y: 30 },
      action: "Never made it to staging",
      transition: 620,
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1850 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-comparators"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in Comparators"
        onOpen={() =>
          requestHandoff({
            target: "comparators",
            label: ".env audit",
            comparator: {
              mode: "env",
              name: ".env Audit",
              a: toEnvFile(COMPARISON_DATA, "prod"),
              b: toEnvFile(COMPARISON_DATA, "stg"),
            },
          })
        }
      />

      {/* Top Filter Bar */}
      <div className="dash-comp-topbar">
        <div className="dash-comp-title">
          <span>.env Audit</span>
        </div>

        <div className="dash-comp-filter-group">
          <button
            type="button"
            data-filter="diffs"
            className={`dash-comp-filter-btn ${filter === "diffs" ? "active" : ""} ${autopilot.hoverClass("filter-diffs")}`}
            onClick={() => setFilter("diffs")}
          >
            <Filter className="h-2.5 w-2.5" />
            <span>Diffs Only ({COMPARISON_DATA.length - counts.match})</span>
          </button>
          <button
            type="button"
            data-filter="all"
            className={`dash-comp-filter-btn ${filter === "all" ? "active" : ""} ${autopilot.hoverClass("filter-all")}`}
            onClick={() => setFilter("all")}
          >
            <span>All ({COMPARISON_DATA.length})</span>
          </button>
        </div>

      </div>

      {/* Reconciled Key Table */}
      <div className="dash-comp-list">
        <div className="dash-comp-head" aria-hidden="true">
          <span className="dash-comp-col key">Key</span>
          <span className="dash-comp-col prod">Production</span>
          <span className="dash-comp-col stg">Staging</span>
          <span className="dash-comp-col status">Status</span>
        </div>

        {displayedData.map((item) => (
          <div key={item.key} data-row={item.key} className={`dash-comp-row ${item.status}`}>
            <div className="dash-comp-col key">
              <code>{item.key}</code>
            </div>

            <div className="dash-comp-col prod">
              <code>{item.prodVal}</code>
            </div>

            <div className="dash-comp-col stg">
              {item.stgVal ? <code>{item.stgVal}</code> : <em className="dash-comp-empty">not set</em>}
            </div>

            <div className="dash-comp-col status">
              {item.status === "match" && (
                <span className="dash-comp-badge match">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  <span>{STATUS_LABEL.match}</span>
                </span>
              )}
              {item.status === "diff" && (
                <span className="dash-comp-badge diff">
                  <AlertCircle className="h-2.5 w-2.5" />
                  <span>{STATUS_LABEL.diff}</span>
                </span>
              )}
              {item.status === "missing" && (
                <span className="dash-comp-badge missing">
                  <XCircle className="h-2.5 w-2.5" />
                  <span>{STATUS_LABEL.missing}</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Real audit totals */}
      <div className="dash-comp-summary">
        <span className="dash-comp-summary-item diff">{counts.diff} mismatched</span>
        <span className="dash-comp-summary-item missing">{counts.missing} missing</span>
        <span className="dash-comp-summary-item match">{counts.match} in sync</span>
        <span className="dash-comp-summary-item muted">Compared on your device</span>
      </div>
    </div>
  );
}
