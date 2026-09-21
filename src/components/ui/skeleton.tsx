// ============================================================
// Skeleton — Geist Design System skeleton loading
// ============================================================
// Follows the Geist skeleton spec (vercel.com/geist/skeleton):
//  - Background: 270° gradient between two adjacent Geist gray
//    surfaces, background-size 400% 100%, 3s ease-in-out wash
//  - Shape mirrors the final element: pill (chips/avatars),
//    rounded (default, text/buttons), squared (image tiles)
//  - Decorative: blocks are aria-hidden; composites set
//    role="status" + aria-busy on the loading region
//  - prefers-reduced-motion disables the sweep (opacity pulse)
//
// SIZING CONTRACT — composites mirror the real elements so the
// reveal does not reflow. Measured from the live CSS:
//   .api-pane-header 40px (title 11px) · .api-tabs-list 38px
//   (triggers 13px) · .status-pill 4px 10px pill · .api-badge
//   48px wide · .api-kv-input 32px · .api-history-card row
//   ~44px · .api-sidebar-header/footer 48px · .api-omnibox 42px
//   .tabs-bar 38px · sidebar 280px
// ============================================================

import React from "react";
import { cn } from "@/lib/utils";

export type SkeletonShape = "rounded" | "pill" | "squared";

export interface SkeletonProps {
  className?: string;
  /** Fixed width (any CSS value); defaults to full width */
  width?: number | string;
  /** Fixed height (any CSS value) */
  height?: number | string;
  /** Shape must mirror the final element (Geist: pill/rounded/squared) */
  shape?: SkeletonShape;
  style?: React.CSSProperties;
}

/** Geist skeleton block — slow 3s gray wash, no tight shimmer */
export function Skeleton({
  className,
  width,
  height,
  shape = "rounded",
  style,
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "geist-skeleton",
        shape === "pill" && "geist-skeleton-pill",
        shape === "squared" && "geist-skeleton-squared",
        className
      )}
      style={{ width, height, ...style }}
    />
  );
}

/** Text line with the shared per-line cascade delay */
function Line({
  w,
  i,
  h = 10,
}: {
  w: number | string;
  i: number;
  h?: number;
}) {
  return (
    <Skeleton
      width={w}
      height={h}
      shape="rounded"
      style={{ animationDelay: `${i * 0.12}s` }}
    />
  );
}

/** Section header row: caret + label + right-aligned action chip */
function SectionHeader({ labelWidth, i }: { labelWidth: number | string; i: number }) {
  return (
    <div className="geist-skeleton-row" style={{ opacity: 0.75, height: 36 }}>
      <Skeleton width={8} height={8} shape="rounded" style={{ animationDelay: `${i * 0.12}s` }} />
      <Skeleton width={labelWidth} height={10} style={{ animationDelay: `${i * 0.12}s` }} />
      <span style={{ flex: 1 }} />
      <Skeleton width={16} height={8} style={{ animationDelay: `${i * 0.12 + 0.06}s` }} />
    </div>
  );
}

/**
 * One sidebar item row — mirrors .api-history-card / .api-preset-card:
 * 48px method badge + url (11.5px line) + meta (10px line) ≈ 44px tall.
 */
function SidebarItemRow({ urlWidth, i }: { urlWidth: number | string; i: number }) {
  return (
    <div className="geist-sidebar-item-skeleton" style={{ animationDelay: `${i * 0.1}s` }}>
      <Skeleton width={48} height={17} shape="rounded" style={{ opacity: 0.85 }} />
      <div className="geist-sidebar-item-lines">
        <Skeleton width={urlWidth} height={11} />
        <Skeleton width="42%" height={8} style={{ opacity: 0.7 }} />
      </div>
    </div>
  );
}

/* ── Shared geometry (mirrors the live components) ─────────── */

/**
 * ResponseSkeleton — API Tester response pane while a request is
 * in flight. Mirrors the real pane structure exactly:
 *   pane header 40px ("RESPONSE" label) → status meta row →
 *   tab strip 38px → body lines that FILL the remaining height
 *   (flex:1) so the pane never shrinks while loading.
 */
export function ResponseSkeleton() {
  return (
    <div
      className="geist-skeleton-region api-response-skeleton geist-cascade"
      role="status"
      aria-label="Loading response"
      aria-busy="true"
    >
      {/* Pane header — mirrors .api-pane-header (40px, uppercase title) */}
      <div className="geist-skeleton-row geist-paneheader-skeleton">
        <Skeleton width={78} height={11} />
        <span style={{ flex: 1 }} />
        <Skeleton width={60} height={11} style={{ opacity: 0.6 }} />
      </div>

      {/* Status meta row — mirrors .status-pill (pill) + .meta-item (11px) */}
      <div className="geist-skeleton-row" style={{ padding: "12px 16px 0" }}>
        <Skeleton width={104} height={22} shape="pill" />
        <Skeleton width={78} height={13} />
        <Skeleton width={58} height={13} />
        <span style={{ flex: 1 }} />
        <Skeleton width={64} height={22} shape="rounded" style={{ opacity: 0.7 }} />
      </div>

      {/* Tab strip — mirrors .api-tabs-list (38px, 13px triggers) */}
      <div className="geist-skeleton-row geist-skeleton-tabs geist-resptabs-skeleton">
        <Skeleton width={78} height={13} />
        <Skeleton width={42} height={13} />
        <Skeleton width={72} height={13} />
        <span style={{ flex: 1 }} />
        <Skeleton width={64} height={13} style={{ opacity: 0.6 }} />
      </div>

      {/* Body — fills remaining pane height; lines spaced like 12.5px
          Monaco line-height rhythm, fading toward the bottom */}
      <div className="geist-editor-skeleton geist-editor-skeleton-embedded">
        {Array.from({ length: 12 }, (_, i) => {
          const widths = [92, 64, 78, 52, 84, 46, 72, 60, 88, 40, 76, 55];
          return (
            <div key={i} className="geist-skeleton-row geist-editor-row">
              <Skeleton width={22} height={9} style={{ opacity: 0.55 }} />
              <Line w={`${widths[i]}%`} i={i} h={9} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * EditorSkeleton — Monaco viewport placeholder: line-number
 * gutters + rounded code lines, Geist gray wash.
 */
export function EditorSkeleton({ lines = 10 }: { lines?: number }) {
  const widths = [88, 64, 78, 52, 82, 70, 90, 46, 74, 60, 84, 55];
  return (
    <div
      className="geist-skeleton-region geist-editor-skeleton"
      role="status"
      aria-label="Loading editor"
      aria-busy="true"
    >
      {Array.from({ length: Math.min(lines, widths.length) }, (_, i) => (
        <div key={i} className="geist-skeleton-row geist-editor-row">
          <Skeleton width={22} height={9} shape="rounded" style={{ opacity: 0.6 }} />
          <Line w={`${widths[i]}%`} i={i} h={9} />
        </div>
      ))}
    </div>
  );
}

/**
 * CardsSkeleton — card grid (Library / DrawFlow packs): avatar
 * circle (pill), title, two description lines per card.
 */
export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="geist-cards-skeleton" role="status" aria-label="Loading items" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="geist-card-skeleton" style={{ animationDelay: `${i * 0.1}s` }}>
          <div className="geist-skeleton-row">
            <Skeleton width={28} height={28} shape="pill" />
            <Skeleton width="55%" height={12} />
          </div>
          <Line w="92%" i={1} h={9} />
          <Line w="70%" i={2} h={9} />
        </div>
      ))}
    </div>
  );
}

/**
 * ApiSidebarSkeleton — mirrors the API Tester sidebar (280px):
 * header 48px (brand icon + title), three sections with 36px
 * headers and ~44px item rows, footer 48px.
 */
export function ApiSidebarSkeleton() {
  return (
    <div
      className="api-sidebar-skeleton geist-cascade"
      role="status"
      aria-label="Loading sidebar"
      aria-busy="true"
    >
      {/* Header — mirrors .api-sidebar-header (48px, 28px brand icon) */}
      <div className="geist-skeleton-row geist-sidebar-header-skeleton">
        <Skeleton width={28} height={28} shape="pill" />
        <Skeleton width={72} height={12} />
        <span style={{ flex: 1 }} />
        <Skeleton width={18} height={18} shape="rounded" style={{ opacity: 0.6 }} />
      </div>

      <div className="api-sidebar-skeleton-sections">
        {/* Presets */}
        <div className="api-sidebar-skeleton-section">
          <SectionHeader labelWidth={54} i={0} />
          <SidebarItemRow urlWidth="70%" i={0} />
          <SidebarItemRow urlWidth="55%" i={1} />
          <SidebarItemRow urlWidth="62%" i={2} />
        </div>

        {/* Collections */}
        <div className="api-sidebar-skeleton-section" style={{ animationDelay: "0.08s" }}>
          <SectionHeader labelWidth={70} i={1} />
          <SidebarItemRow urlWidth="48%" i={3} />
          <SidebarItemRow urlWidth="58%" i={4} />
        </div>

        {/* Request History */}
        <div className="api-sidebar-skeleton-section" style={{ animationDelay: "0.16s" }}>
          <SectionHeader labelWidth={88} i={2} />
          <SidebarItemRow urlWidth="64%" i={5} />
          <SidebarItemRow urlWidth="52%" i={6} />
          <SidebarItemRow urlWidth="66%" i={7} />
          <SidebarItemRow urlWidth="44%" i={8} />
        </div>
      </div>

      {/* Footer — mirrors .api-sidebar-footer (48px) */}
      <div className="geist-skeleton-row geist-sidebar-footer-skeleton">
        <Skeleton width={20} height={20} shape="rounded" style={{ opacity: 0.7 }} />
        <Skeleton width={52} height={11} style={{ opacity: 0.7 }} />
      </div>
    </div>
  );
}

/**
 * WorkspaceSkeleton — API Tester init fallback. Mirrors the full
 * page: sidebar (header 48px / sections / footer 48px), tab bar
 * (38px) with method-badge tabs, omnibox row (42px chips + URL +
 * Send button), and the request/response split panes.
 */
export function WorkspaceSkeleton() {
  return (
    <div
      className="geist-workspace-skeleton geist-cascade"
      role="status"
      aria-label="Loading workspace"
      aria-busy="true"
    >
      {/* URL bar row — protocol chip · method chip · URL · Send (42px) */}
      <div className="geist-skeleton-row geist-urlbar-skeleton">
        <Skeleton width={92} height={42} shape="rounded" />
        <Skeleton width={78} height={42} shape="rounded" />
        <Skeleton width="38%" height={42} shape="rounded" />
        <Skeleton width={96} height={42} shape="rounded" style={{ opacity: 0.85 }} />
      </div>

      {/* Tab strip — method badge tabs (48px badges) + new-tab + actions */}
      <div className="geist-skeleton-row geist-tabbar-skeleton">
        <Skeleton width={92} height={26} shape="rounded" style={{ opacity: 0.9 }} />
        <Skeleton width={78} height={26} shape="rounded" style={{ opacity: 0.7 }} />
        <Skeleton width={26} height={26} shape="rounded" style={{ opacity: 0.5 }} />
        <span style={{ flex: 1 }} />
        <Skeleton width={92} height={26} shape="pill" style={{ opacity: 0.6 }} />
        <Skeleton width={70} height={26} shape="pill" style={{ opacity: 0.6 }} />
      </div>

      {/* Request / response split panes */}
      <div className="geist-workspace-panes">
        <div className="geist-workspace-pane">
          {/* Request pane: header 40px + tabs + kv rows (32px inputs) */}
          <div className="geist-skeleton-region" style={{ height: "100%", gap: 10 }}>
            <div className="geist-skeleton-row geist-paneheader-skeleton">
              <Skeleton width={62} height={11} />
              <span style={{ flex: 1 }} />
            </div>
            <div className="geist-skeleton-row" style={{ padding: "0 16px", gap: 12 }}>
              <Skeleton width={54} height={12} />
              <Skeleton width={50} height={12} />
              <Skeleton width={56} height={12} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 16px" }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="geist-skeleton-row" style={{ height: 32, gap: 8 }}>
                  <Skeleton width={14} height={14} shape="rounded" style={{ opacity: 0.6 }} />
                  <Skeleton width="34%" height={32} shape="rounded" />
                  <Skeleton width="42%" height={32} shape="rounded" />
                  <Skeleton width={18} height={18} shape="rounded" style={{ opacity: 0.5 }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="geist-workspace-pane">
          {/* Response pane: header + meta + tabs + body */}
          <div className="geist-skeleton-region" style={{ height: "100%", gap: 10 }}>
            <div className="geist-skeleton-row geist-paneheader-skeleton">
              <Skeleton width={78} height={11} />
              <span style={{ flex: 1 }} />
            </div>
            <div className="geist-skeleton-row" style={{ padding: "0 16px", gap: 8 }}>
              <Skeleton width={96} height={22} shape="pill" />
              <Skeleton width={70} height={12} />
              <Skeleton width={52} height={12} />
            </div>
            <div
              className="geist-skeleton-row"
              style={{ padding: "0 16px 8px", borderBottom: "1px solid var(--ds-gray-alpha-200)" }}
            >
              <Skeleton width={72} height={12} />
              <Skeleton width={40} height={12} />
              <Skeleton width={64} height={12} />
            </div>
            {Array.from({ length: 7 }, (_, i) => {
              const widths = [86, 58, 74, 44, 68, 80, 50];
              return (
                <div key={i} className="geist-skeleton-row" style={{ padding: "0 16px", gap: 12 }}>
                  <Skeleton width={18} height={9} style={{ opacity: 0.55 }} />
                  <Line w={`${widths[i]}%`} i={i} h={9} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
