// ============================================================
// Busy — The One Busy-Indicator System For The Whole Chat
// ============================================================
// Before this file there was one glyph — a spinning Loader2 — doing four
// different jobs, sometimes five of them on screen during a single turn:
// the agent's work (rail, plan strip, tool rows, sidebar, shell pill), the
// environment (workspace boot, dev server), the user's own click (run
// checks, push, settings loads), and model generation (the thinking dots).
// Same shape, four meanings, so the screen could not be read at a glance.
//
// Four variants, one component:
//
//   • work    — THE agent-working indicator. Accent-coloured spinner. Drawn
//               by the ActivityRail only; every other surface that used to
//               spin for the same fact draws `pending` instead, so exactly
//               one `work` spinner exists per screen.
//   • pending — a hollow ring, pulsing, no rotation. "Something here is in
//               progress, and you are not the surface that narrates it."
//               Used by the plan strip's active step, a pending tool row and
//               the sidebar's running row — visibly busy, never competing
//               with the rail, and a different SHAPE from `work` so the two
//               cannot be confused.
//   • env     — a muted spinner. Environment state: the workspace booting,
//               a dev server starting. Not the agent, not a click — the
//               plumbing underneath them.
//   • action  — a tiny spinner for button-local work the user started
//               ("Checking…", push executing, a settings load). The only
//               variant that may sit inside a button.
//
// Model generation is NOT a spinner at all: ThinkingDots is the one motion
// language for it (the transcript's dots bubble and the rail's thinking
// phase both render it), so "the model is composing" never looks like
// "a fetch is in flight".
//
// Motion collapses through one class set, so prefers-reduced-motion is
// handled once — here and in chat.css — instead of per surface. The
// Tailwind `animate-spin` usages in the settings modal had no such
// coverage; everything goes through this component now.
// ============================================================

import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type BusyVariant = "work" | "pending" | "env" | "action";

interface BusyProps {
  variant: BusyVariant;
  /** Accessible name for the wait (a spinner alone says nothing) */
  label: string;
  className?: string;
}

/**
 * The semantic busy indicator.
 *
 * Every variant renders an icon plus an sr-only label, so a screen reader
 * hears "the agent is working" rather than "image". Color, shape and motion
 * are the variant's; callers choose the meaning, not the styling.
 */
export function Busy({ variant, label, className }: BusyProps) {
  const sr = <span className="chat-sr-only">{label}</span>;

  // `pending` is deliberately NOT a rotation: a second spinning circle
  // beside the rail's is the exact duplication this component exists to
  // end, and a pulse reads as "in progress" without claiming to be THE
  // progress surface.
  if (variant === "pending") {
    return (
      <span className={cn("chat-busy chat-busy-pending", className)} role="status">
        <span className="chat-busy-ring" aria-hidden="true" />
        {sr}
      </span>
    );
  }

  return (
    <span className={cn("chat-busy", `chat-busy-${variant}`, className)} role="status">
      <Loader2 className="chat-busy-icon" aria-hidden="true" />
      {sr}
    </span>
  );
}

/** Shared with lib/ActivityRail? No — with the two surfaces that speak for model generation. */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("chat-thinking", className)} role="status" aria-label="Assistant is thinking">
      <span className="chat-thinking-dot" />
      <span className="chat-thinking-dot" />
      <span className="chat-thinking-dot" />
    </span>
  );
}
