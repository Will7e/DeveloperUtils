import * as React from "react";
import { cn } from "@/lib/utils";

export interface ToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: "sm" | "md" | "lg";
  label?: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * Geist Switch — track off = Gray 3, on = Gray 1000 (high contrast),
 * never colored. Thumb = Background 100. Focus ring per spec.
 */
const sizeConfig = {
  sm: {
    track: "w-7 h-4",
    thumb: "size-3",
    translate: "translate-x-3",
    initial: "translate-x-0.5",
  },
  md: {
    track: "w-9 h-5",
    thumb: "size-4",
    translate: "translate-x-4",
    initial: "translate-x-0.5",
  },
  lg: {
    track: "w-11 h-6",
    thumb: "size-5",
    translate: "translate-x-5",
    initial: "translate-x-0.5",
  },
};

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  (
    {
      checked: controlledChecked,
      defaultChecked = false,
      onCheckedChange,
      size = "md",
      label,
      description,
      disabled = false,
      className,
      onClick,
      onKeyDown,
      ...props
    },
    ref
  ) => {
    const [uncontrolledChecked, setUncontrolledChecked] =
      React.useState(defaultChecked);
    const isControlled = controlledChecked !== undefined;
    const isChecked = isControlled ? controlledChecked : uncontrolledChecked;

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) return;
      onClick?.(e);
      if (e.defaultPrevented) return;

      const nextChecked = !isChecked;
      if (!isControlled) {
        setUncontrolledChecked(nextChecked);
      }
      onCheckedChange?.(nextChecked);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleClick(e as unknown as React.MouseEvent<HTMLButtonElement>);
      }
    };

    const cfg = sizeConfig[size] || sizeConfig.md;

    const toggleButton = (
      <button
        type="button"
        role="switch"
        ref={ref}
        aria-checked={isChecked}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        data-geist-toggle=""
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer rounded-full transition-colors duration-150 ease-out outline-none select-none items-center",
          "focus-visible:shadow-[var(--ds-focus-ring)]",
          cfg.track,
          isChecked
            ? "bg-[var(--ds-gray-1000)]"
            : "bg-[var(--ds-gray-400)] hover:bg-[var(--ds-gray-500)]",
          disabled && "opacity-50 cursor-not-allowed pointer-events-none",
          className
        )}
        {...props}
      >
        <span
          className={cn(
            "pointer-events-none block rounded-full bg-[var(--ds-background-100)] shadow-sm transition-transform duration-150 ease-out",
            cfg.thumb,
            isChecked ? cfg.translate : cfg.initial
          )}
        />
      </button>
    );

    if (!label && !description) {
      return toggleButton;
    }

    return (
      <div
        className={cn(
          "inline-flex items-center justify-between gap-3 select-none",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <div className="flex flex-col">
          {label && (
            <span className="text-[13px] font-medium text-[var(--ds-gray-1000)]">
              {label}
            </span>
          )}
          {description && (
            <span className="text-xs text-[var(--ds-gray-700)]">
              {description}
            </span>
          )}
        </div>
        {toggleButton}
      </div>
    );
  }
);
Toggle.displayName = "Toggle";
