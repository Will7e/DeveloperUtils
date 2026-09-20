// ============================================================
// Autopilot Scheduler
// ============================================================
// The dashboard renders eight live demos. Animating all of them at
// once burns CPU on motion nobody is watching, so exactly one demo
// runs: the most visible one in the viewport. Everything else holds
// its current frame until it becomes the most visible demo.

type DemoEntry = {
  setActive: (active: boolean) => void;
};

const registry = new Map<string, DemoEntry>();
const ratios = new Map<string, number>();

let observer: IntersectionObserver | null = null;
let forcedId: string | null = null;

/** A demo must be at least this visible before it may animate. */
const MIN_VISIBLE_RATIO = 0.25;

function elect(): void {
  let winner: string | null = null;
  let bestRatio = 0;

  if (!document.hidden) {
    for (const [id, ratio] of ratios) {
      if (!registry.has(id)) continue;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        winner = id;
      }
    }
    if (bestRatio < MIN_VISIBLE_RATIO) winner = null;
  }

  // An explicit play press overrides motion preferences, never visibility:
  // the demo still has to be on screen to animate.
  if (forcedId) {
    const forcedVisible = (ratios.get(forcedId) ?? 0) > 0 && registry.has(forcedId);
    winner = forcedVisible ? forcedId : null;
  }

  for (const [id, entry] of registry) {
    entry.setActive(id === winner);
  }
}

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target instanceof HTMLElement ? entry.target.dataset.autopilotId : undefined;
        if (id) ratios.set(id, entry.intersectionRatio);
      }
      elect();
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] }
  );
  return observer;
}

let visibilityListenerAttached = false;

/**
 * Registers a demo with the scheduler. `setActive` receives `true` only
 * while this demo is the elected one. Returns an unsubscribe function.
 */
export function registerDemo(
  id: string,
  element: HTMLElement,
  setActive: (active: boolean) => void
): () => void {
  registry.set(id, { setActive });
  element.dataset.autopilotId = id;
  ensureObserver().observe(element);

  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener("visibilitychange", elect);
  }

  return () => {
    registry.delete(id);
    ratios.delete(id);
    observer?.unobserve(element);
    if (forcedId === id) forcedId = null;
    setActive(false);
  };
}

/** Motion preferences and input type decide whether demos may animate at all. */
export function isMotionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isPointerFine(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(pointer: coarse)").matches;
}

/** Manual override used by the play button so reduced-motion users can opt in. */
export function forceAutoplay(id: string | null): void {
  forcedId = id;
  elect();
}

export function getForcedAutoplay(): string | null {
  return forcedId;
}
