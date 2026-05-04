// ============================================================
// Toast Notifications — Transient feedback messages
// ============================================================

import { CheckCircle, Info, XCircle } from "lucide-react";
import { useAppStore } from "@/stores/app.store";

const icons = {
  info: <Info style={{ width: 14, height: 14 }} />,
  success: <CheckCircle style={{ width: 14, height: 14 }} />,
  error: <XCircle style={{ width: 14, height: 14 }} />,
};

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="toast-icon">{icons[toast.type]}</span>
          <span className="toast-message">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
