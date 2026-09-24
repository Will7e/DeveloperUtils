// ============================================================
// Toast Notifications — Geist Design System Transient Feedback
// Auto-dismiss with pause-on-hover, exit animation, aria-live.
// ============================================================

import * as React from "react";
import { useAppStore } from "@/stores/app.store";
import { Toast, type ToastVariant } from "@/components/ui/toast";

/** Mapping from the store's Toast type to a Geist variant */
const variantFor: Record<string, ToastVariant> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

/** How long the exit animation runs before removal from the store */
const EXIT_MS = 160;

/** Geist default auto-dismiss delay */
const DEFAULT_DURATION_MS = 3000;

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  /** Toasts currently playing their exit animation */
  const [leavingIds, setLeavingIds] = React.useState<Set<string>>(new Set());

  /** Auto-dismiss timers, so hover can pause & resume them */
  const timersRef = React.useRef(new Map<string, number>());
  /** Remaining time at pause; used to resume after unhover */
  const remainingRef = React.useRef(new Map<string, number>());
  /** When the current timer arm started */
  const startedAtRef = React.useRef(new Map<string, number>());

  const clearTimer = React.useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = React.useCallback(
    (id: string) => {
      if (leavingIds.has(id)) return;
      clearTimer(id);
      remainingRef.current.delete(id);
      startedAtRef.current.delete(id);
      setLeavingIds((prev) => new Set(prev).add(id));
      window.setTimeout(() => {
        removeToast(id);
        setLeavingIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, EXIT_MS);
    },
    [clearTimer, removeToast, leavingIds]
  );

  const armTimer = React.useCallback(
    (id: string, ms: number) => {
      clearTimer(id);
      remainingRef.current.set(id, ms);
      startedAtRef.current.set(id, Date.now());
      timersRef.current.set(id, window.setTimeout(() => dismiss(id), ms));
    },
    [clearTimer, dismiss]
  );

  const pause = React.useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t === undefined) return;
    window.clearTimeout(t);
    timersRef.current.delete(id);
    const startedAt = startedAtRef.current.get(id) ?? Date.now();
    const left = remainingRef.current.get(id) ?? 0;
    remainingRef.current.set(id, Math.max(0, left - (Date.now() - startedAt)));
  }, []);

  const resume = React.useCallback(
    (id: string) => {
      if (timersRef.current.has(id)) return;
      const left = remainingRef.current.get(id);
      if (left === undefined) return;
      if (left <= 0) {
        dismiss(id);
        return;
      }
      startedAtRef.current.set(id, Date.now());
      timersRef.current.set(id, window.setTimeout(() => dismiss(id), left));
    },
    [dismiss]
  );

  // Arm auto-dismiss timers for new toasts; clean up mirrors for gone ones
  React.useEffect(() => {
    for (const t of toasts) {
      if (leavingIds.has(t.id)) continue;
      if (timersRef.current.has(t.id)) continue;
      // Geist: default 3s auto-dismiss; preserve/Infinity keeps the toast on screen
      const sticky =
        t.preserve === true || t.duration === Infinity || t.duration === 0;
      if (sticky) continue;
      armTimer(t.id, t.duration ?? DEFAULT_DURATION_MS);
    }
    for (const id of [...timersRef.current.keys()]) {
      if (!toasts.some((t) => t.id === id)) clearTimer(id);
    }
  }, [toasts, leavingIds, armTimer, clearTimer]);

  // Clear all timers on unmount
  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleAction = (id: string, action?: { onClick: () => void }) => {
    action?.onClick();
    dismiss(id);
  };

  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[999999] flex flex-col items-end gap-2.5 pointer-events-none max-w-[calc(100vw-2rem)] sm:max-w-fit w-auto"
    >
      {toasts.map((toast) => {
        const variant = variantFor[toast.type] ?? "info";
        const leaving = leavingIds.has(toast.id);
        const sticky =
          toast.preserve === true ||
          toast.duration === Infinity ||
          toast.duration === 0;
        const dismissable = !sticky;
        return (
          <div
            key={toast.id}
            className={
              leaving
                ? "pointer-events-auto flex justify-end w-full sm:w-auto animate-toast-out"
                : "pointer-events-auto flex justify-end w-full sm:w-auto"
            }
            onMouseEnter={() => pause(toast.id)}
            onMouseLeave={() => resume(toast.id)}
          >
            <Toast
              variant={variant}
              title={toast.title}
              message={toast.message}
              leaving={leaving}
              action={
                toast.action && !leaving
                  ? {
                      label: toast.action.label,
                      onClick: () => handleAction(toast.id, toast.action),
                    }
                  : undefined
              }
              onClose={dismissable ? () => dismiss(toast.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
