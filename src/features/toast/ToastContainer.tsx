// ============================================================
// Toast Notifications — Geist Design System Transient Feedback
// ============================================================

import { useAppStore } from "@/stores/app.store";
import { Toast, type ToastVariant } from "@/components/ui/toast";

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-6 right-6 z-[999999] flex flex-col gap-2.5 pointer-events-none max-w-[420px] w-full items-end"
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          variant={(toast.type as ToastVariant) || "info"}
          message={toast.message}
          onClose={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}
