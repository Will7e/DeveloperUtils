import * as React from "react";
import { CircleCheck, CircleAlert, TriangleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Geist Toast — per vercel.com/geist/toast
 * Variants: default (no icon), info, success, warning, error.
 * Content: one sentence, sentence case, no trailing period.
 */
export type ToastVariant = "info" | "success" | "warning" | "error" | "default";

export interface ToastProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: ToastVariant;
  title?: React.ReactNode;
  message: React.ReactNode;
  icon?: React.ReactNode | false;
  action?: {
    label: string;
    onClick: () => void;
  };
  onClose?: () => void;
  /** When true, plays the exit animation (managed by ToastContainer) */
  leaving?: boolean;
}

const variantIcons: Record<ToastVariant, React.ReactNode | null> = {
  default: null,
  info: <Info className="size-4 text-[var(--ds-blue-900)] shrink-0" />,
  success: <CircleCheck className="size-4 text-[var(--ds-green-900)] shrink-0" />,
  warning: <TriangleAlert className="size-4 text-[var(--ds-amber-700)] shrink-0" />,
  error: <CircleAlert className="size-4 text-[var(--ds-red-800)] shrink-0" />,
};

export const Toast = React.forwardRef<HTMLDivElement, ToastProps>(
  (
    {
      variant = "info",
      title,
      message,
      icon,
      action,
      onClose,
      leaving = false,
      className,
      ...props
    },
    ref
  ) => {
    const resolvedIcon =
      icon !== undefined
        ? icon === false
          ? null
          : icon
        : (variantIcons[variant] ?? null);

    return (
      <div
        ref={ref}
        data-toast-state={leaving ? "leaving" : "entered"}
        data-toast-variant={variant}
        className={cn(
          // Layout only — background, padding, radius and elevation come from
          // styles/toast.css so they can't be stripped by a CSS reset.
          "group pointer-events-auto relative flex items-center gap-3 w-full sm:w-[380px] select-none",
          "animate-toast-in text-[13px] leading-5",
          className
        )}
        {...props}
      >
        {resolvedIcon && (
          <div className="shrink-0 flex items-center justify-center">
            {resolvedIcon}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-center">
          {title && (
            <div className="text-[13px] font-semibold text-[var(--ds-gray-1000)] leading-tight mb-0.5">
              {title}
            </div>
          )}
          <div className="text-[13px] text-[var(--ds-gray-1000)] leading-5 break-words select-text font-normal">
            {message}
          </div>
        </div>

        {(action || onClose) && (
          <div className="shrink-0 flex items-center gap-2">
            {action && !leaving && (
              <button
                type="button"
                onClick={action.onClick}
                className="h-7 px-2.5 text-xs font-medium rounded-md border border-[var(--ds-gray-alpha-400)] bg-[var(--ds-gray-100)] hover:bg-[var(--ds-gray-200)] active:bg-[var(--ds-gray-300)] text-[var(--ds-gray-1000)] transition-colors cursor-pointer outline-none focus-visible:shadow-[var(--ds-focus-ring)] active:scale-[0.97] whitespace-nowrap"
              >
                {action.label}
              </button>
            )}

            {onClose && !leaving && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Dismiss notification"
                className="size-6 flex items-center justify-center text-[var(--ds-gray-700)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-200)] active:bg-[var(--ds-gray-300)] rounded-md transition-colors cursor-pointer outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
);
Toast.displayName = "Toast";

