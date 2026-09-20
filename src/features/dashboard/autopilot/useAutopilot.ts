// ============================================================
// useAutopilot — declarative animated demo cursor
// ============================================================
// Every dashboard demo used to hand-roll its own copy of the same loop:
// a step counter, an interval, a pile of timeouts that were never
// cleared, and a hover/idle pair. This hook owns that logic once, driven
// by a list of steps that describe *what* the demo does.
//
// Guarantees:
//  - one timer chain per step, always cleared on pause/unmount/step change
//  - steps may be rebuilt on every render without restarting the loop
//  - the demo pauses on hover and on keyboard focus, and only animates
//    while the scheduler has elected it (see scheduler.ts)

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";
import type { CursorType, VirtualCursorProps } from "../components/VirtualCursor";
import { forceAutoplay, isMotionAllowed, isPointerFine, registerDemo } from "./scheduler";

/** A selector, an element, raw coordinates, or nothing. */
export type CursorTarget = string | HTMLElement | CursorPosition | null;

/** A target, or a function resolved when the step runs (so refs are never read during render). */
export type CursorTargetResolver = CursorTarget | (() => CursorTarget);

export interface AutopilotStep {
  /** Where the cursor glides to. Omit to leave it where it is. */
  target?: CursorTargetResolver;
  /** Percentage coordinates used when `target` cannot be measured. */
  fallback?: { x: number; y: number };
  /** Text shown next to the cursor, e.g. "Run script". */
  action?: string;
  cursor?: CursorType;
  /** Cursor glide duration in ms (default 500). */
  transition?: number;
  /** Virtual hover key applied just before the click. */
  hover?: string;
  hoverAt?: number;
  /** Fired at the click moment. */
  run?: () => void;
  runAt?: number;
  releaseAt?: number;
  click?: boolean;
  /** How long the step lasts before advancing (default: `stepMs`). */
  hold?: number;
}

export interface AutopilotControls {
  /** True whenever no animation is running, for any reason. */
  isPaused: boolean;
  /** False when the environment forbids autoplay (reduced motion, touch). */
  canPlay: boolean;
  /** True when the viewer explicitly started playback under reduced motion. */
  isForced: boolean;
  pause: () => void;
  play: () => void;
}

export interface Autopilot {
  /** Spread onto the demo's root element. */
  containerProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocusCapture: () => void;
    onBlurCapture: () => void;
  };
  /** Spread onto <VirtualCursor />. */
  cursorProps: VirtualCursorProps;
  hoverClass: (key: string) => string;
  controls: AutopilotControls;
  isRunning: boolean;
}

export interface AutopilotOptions {
  /** Step duration in ms. */
  stepMs?: number;
  /** Idle delay before autopilot resumes after the pointer leaves. */
  resumeAfterMs?: number;
}

const DEFAULT_FALLBACK = { x: 50, y: 40 };

export function useAutopilot<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  steps: AutopilotStep[],
  options: AutopilotOptions = {}
): Autopilot {
  const { stepMs = 1800, resumeAfterMs = 2400 } = options;
  const demoId = useId();

  // Steps are read through a ref so rebuilding the array every render
  // (to capture fresh state) never restarts the running step.
  const stepsRef = useRef(steps);
  useEffect(() => {
    stepsRef.current = steps;
  });

  const timersRef = useRef<number[]>([]);
  const resumeTimerRef = useRef<number | null>(null);

  const [position, setPosition] = useState<CursorPosition>({ ...DEFAULT_FALLBACK, isPercent: true });
  const [duration, setDuration] = useState<number>(500);
  const [cursorType, setCursorType] = useState<CursorType>("pointer");
  const [actionText, setActionText] = useState<string>("Ready");
  const [isClicking, setIsClicking] = useState<boolean>(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const [isElected, setIsElected] = useState<boolean>(false);
  const [isEngaged, setIsEngaged] = useState<boolean>(false);
  const [isPausedByUser, setIsPausedByUser] = useState<boolean>(false);
  const [isForced, setIsForced] = useState<boolean>(false);
  const [stepIndex, setStepIndex] = useState<number>(0);

  // Read once: motion preferences and input type do not change mid-session.
  const [canPlay] = useState<boolean>(
    () => isMotionAllowed() && isPointerFine()
  );

  // The scheduler decides when this demo is the one allowed to animate.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    return registerDemo(demoId, element, setIsElected);
  }, [containerRef, demoId]);

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const isRunning = isElected && !isEngaged && !isPausedByUser && (canPlay || isForced);

  // One timer chain per step. Every advance re-runs this effect, so no
  // callback can outlive the step that scheduled it.
  useEffect(() => {
    if (!isRunning) return;

    const list = stepsRef.current;
    if (list.length === 0) return;
    const step = list[stepIndex % list.length];
    if (!step) return;

    timersRef.current = [];
    const after = (ms: number, fn: () => void) => {
      timersRef.current = [...timersRef.current, window.setTimeout(fn, ms)];
    };

    const transition = step.transition ?? 500;
    if (step.action) setActionText(step.action);
    if (step.cursor) setCursorType(step.cursor);
    setDuration(transition);

    if (step.target !== undefined) {
      const resolved = typeof step.target === "function" ? step.target() : step.target;
      if (typeof resolved === "string" || resolved instanceof HTMLElement) {
        setPosition(
          getTargetCenter(containerRef.current, resolved, step.fallback ?? DEFAULT_FALLBACK)
        );
      } else if (resolved) {
        setPosition({ ...resolved, isPercent: resolved.isPercent ?? false });
      }
    }

    const runAt = step.runAt ?? transition;
    const wantsClick = step.click ?? Boolean(step.run);

    if (step.hover) {
      const hoverAt = step.hoverAt ?? Math.min(340, Math.max(120, Math.round(transition * 0.65)));
      after(hoverAt, () => setHoverKey(step.hover ?? null));
    }

    if (wantsClick) after(runAt, () => setIsClicking(true));
    if (step.run) after(runAt, step.run);

    after(step.releaseAt ?? runAt + 200, () => {
      setIsClicking(false);
      setHoverKey(null);
    });

    after(step.hold ?? stepMs, () => setStepIndex((current) => current + 1));

    return () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
      setHoverKey(null);
      setIsClicking(false);
    };
    // `steps` is intentionally absent: stepsRef always holds the latest list.
  }, [isRunning, stepIndex, stepMs, containerRef]);

  const pause = () => {
    setIsPausedByUser(true);
    if (isForced) {
      setIsForced(false);
      forceAutoplay(null);
    }
  };

  const play = () => {
    setIsPausedByUser(false);
    if (!canPlay) {
      // Explicit opt-in: the viewer asked for motion we would otherwise skip.
      setIsForced(true);
      forceAutoplay(demoId);
    }
  };

  const containerProps = useMemo(
    () => ({
      onMouseEnter: () => {
        if (resumeTimerRef.current !== null) {
          window.clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = null;
        }
        setIsEngaged(true);
        setHoverKey(null);
      },
      onMouseLeave: () => {
        if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = window.setTimeout(() => setIsEngaged(false), resumeAfterMs);
      },
      // Keyboard users get a still demo, and their focus is never chased.
      onFocusCapture: () => {
        if (resumeTimerRef.current !== null) {
          window.clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = null;
        }
        setIsEngaged(true);
      },
      onBlurCapture: () => setIsEngaged(false),
    }),
    [resumeAfterMs]
  );

  const cursorProps: VirtualCursorProps = {
    x: position.x,
    y: position.y,
    isPercent: position.isPercent ?? true,
    isClicking,
    visible: isRunning,
    actionText,
    cursorType,
    transitionDuration: duration,
  };

  return {
    containerProps,
    cursorProps,
    hoverClass: (key: string) => (hoverKey === key ? "is-virtual-hover" : ""),
    controls: {
      isPaused: !isRunning,
      canPlay,
      isForced,
      pause,
      play,
    },
    isRunning,
  };
}
