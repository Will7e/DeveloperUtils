import { useState } from "react";
import { Filter, CheckCircle2, AlertCircle, XCircle } from "lucide-react";

interface KeyComparison {
  key: string;
  prodVal: string;
  stgVal: string;
  status: "match" | "diff" | "missing";
}

const COMPARISON_DATA: KeyComparison[] = [
  { key: "DB_PORT", prodVal: "5432", stgVal: "5432", status: "match" },
  { key: "API_KEY", prodVal: "prod_live_8a", stgVal: "stg_test_2b", status: "diff" },
  { key: "REDIS_HOST", prodVal: "redis-prod.internal", stgVal: "[missing]", status: "missing" },
  { key: "LOG_LEVEL", prodVal: "warn", stgVal: "debug", status: "diff" },
];

export function ComparatorsPreview() {
  const [filter, setFilter] = useState<"diffs" | "all">("diffs");

  const displayedData =
    filter === "diffs"
      ? COMPARISON_DATA.filter((d) => d.status !== "match")
      : COMPARISON_DATA;

  return (
    <div
      className="dash-demo-box dash-demo-comparators"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top Filter Bar */}
      <div className="dash-comp-topbar">
        <div className="dash-comp-title">
          <span>.env Audit</span>
        </div>

        <div className="dash-comp-filter-group">
          <button
            type="button"
            className={`dash-comp-filter-btn ${filter === "diffs" ? "active" : ""}`}
            onClick={() => setFilter("diffs")}
          >
            <Filter className="h-2.5 w-2.5" />
            <span>Diffs Only (3)</span>
          </button>
          <button
            type="button"
            className={`dash-comp-filter-btn ${filter === "all" ? "active" : ""}`}
            onClick={() => setFilter("all")}
          >
            <span>All (4)</span>
          </button>
        </div>
      </div>

      {/* Reconciled Key Table */}
      <div className="dash-comp-list">
        {displayedData.map((item) => (
          <div key={item.key} className={`dash-comp-row ${item.status}`}>
            <div className="dash-comp-col key">
              <code>{item.key}</code>
            </div>

            <div className="dash-comp-col status">
              {item.status === "match" && (
                <span className="dash-comp-badge match">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  <span>Equal</span>
                </span>
              )}
              {item.status === "diff" && (
                <span className="dash-comp-badge diff">
                  <AlertCircle className="h-2.5 w-2.5" />
                  <span>Mismatch</span>
                </span>
              )}
              {item.status === "missing" && (
                <span className="dash-comp-badge missing">
                  <XCircle className="h-2.5 w-2.5" />
                  <span>Missing</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
