// ============================================================
// PageSkeleton — Geist skeleton fallback for lazy routes
// ============================================================
// Shaped like a generic tool page: header bar, toolbar row of
// pills, then a large content block. Replaces the bare
// Route loads read as structured content,
// per Geist guidance to skeleton known layouts.

import { Skeleton } from "./skeleton";

export function PageSkeleton() {
  return (
    <div
      className="geist-page-skeleton"
      role="status"
      aria-label="Loading page"
      aria-busy="true"
    >
      {/* Page header */}
      <div className="geist-skeleton-row" style={{ marginBottom: 18 }}>
        <Skeleton width={28} height={28} shape="pill" />
        <Skeleton width="30%" height={14} />
      </div>

      {/* Toolbar row */}
      <div className="geist-skeleton-row" style={{ marginBottom: 18 }}>
        <Skeleton width={72} height={24} shape="pill" />
        <Skeleton width={56} height={24} shape="pill" />
        <Skeleton width={64} height={24} shape="pill" />
      </div>

      {/* Main content block */}
      <div className="geist-page-skeleton-body">
        {[88, 70, 80, 55, 74].map((w, i) => (
          <Skeleton
            key={i}
            width={`${w}%`}
            height={10}
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </div>
    </div>
  );
}
