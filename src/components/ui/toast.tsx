import * as React from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: ToastVariant;
  title?: React.ReactNode;
  message: React.ReactNode;
  action?: {
    label: string;
    onClick: () => void;
  };
  onClose?: () => void;
}

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  info: <Info className="size-4 text-[var(--ds-blue-700)] shrink-0" />,
  success: <CheckCircle2 className="size-4 text-[var(--ds-blue-700)] shrink-0" />,
  warning: <AlertTriangle className="size-4 text-[var(--ds-amber-700)] shrink-0" />,
  error: <AlertCircle className="size-4 text-[var(--ds-red-800)] shrink-0" />,
};

export const Toast = React.forwardRef<HTMLDivElement, ToastProps>(
  (
    {
      variant = "info",
      title,
      message,
      action,
      onClose,
      className,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        data-geist-toast=""
        className={cn(
          "pointer-events-auto flex items-start gap-3 w-full max-w-[380px] p-3.5 rounded-lg select-none",
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)]",
          "shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition-all duration-200",
          "animate-toast-in",
          className
        )}
        {...props}
      >
        <div className="mt-0.5">{variantIcons[variant]}</div>

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {title && (
            <div className="text-sm font-semibold text-[var(--ds-gray-1000)] leading-tight">
              {title}
            </div>
          )}
          <div className="text-[13px] text-[var(--ds-gray-900)] leading-snug break-words">
            {message}
          </div>
        </div>

        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 h-7 px-2.5 text-xs font-medium rounded border border-[var(--ds-gray-400)] bg-transparent hover:bg-[var(--ds-gray-200)] text-[var(--ds-gray-1000)] transition-colors cursor-pointer outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
          >
            {action.label}
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss notification"
            className="shrink-0 text-[var(--ds-gray-700)] hover:text-[var(--ds-gray-1000)] p-0.5 rounded transition-colors cursor-pointer outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    );
  }
);
Toast.displayName = "Toast";
