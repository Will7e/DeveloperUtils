import * as React from "react";
import { cn } from "@/lib/utils";

export interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      checked: controlledChecked,
      defaultChecked = false,
      indeterminate = false,
      onCheckedChange,
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

    return (
      <button
        type="button"
        role="checkbox"
        ref={ref}
        aria-checked={indeterminate ? "mixed" : isChecked}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex items-center justify-center size-4 shrink-0 rounded-sm transition-all duration-150 cursor-pointer select-none outline-none",
          "focus-visible:shadow-[var(--ds-focus-ring)]",
          // Checked state: solid gray-1000 with inverted text/stroke
          isChecked && !indeterminate && [
            "bg-[var(--ds-gray-1000)] border border-[var(--ds-gray-1000)] text-[var(--ds-background-100)]",
            disabled && "bg-[var(--ds-gray-600)] border-[var(--ds-gray-600)] opacity-80 cursor-not-allowed",
          ],
          // Indeterminate state
          indeterminate && [
            "bg-[var(--ds-background-100)] border border-[var(--ds-gray-700)] text-[var(--ds-gray-700)]",
            disabled && "bg-[var(--ds-gray-100)] border-[var(--ds-gray-500)] text-[var(--ds-gray-500)] cursor-not-allowed",
          ],
          // Unchecked state
          !isChecked && !indeterminate && [
            "bg-[var(--ds-background-100)] border border-[var(--ds-gray-700)] text-transparent",
            !disabled && "hover:bg-[var(--ds-gray-200)]",
            disabled && "bg-[var(--ds-gray-100)] border-[var(--ds-gray-500)] cursor-not-allowed",
          ],
          className
        )}
        {...props}
      >
        {indeterminate ? (
          <svg
            fill="none"
            height="16"
            viewBox="0 0 20 20"
            width="16"
            className="size-3.5 stroke-current"
          >
            <line
              x1="5"
              y1="10"
              x2="15"
              y2="10"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : isChecked ? (
          <svg
            fill="none"
            height="16"
            viewBox="0 0 20 20"
            width="16"
            className="size-3.5 stroke-current"
          >
            <path
              d="M14 7L8.5 12.5L6 10"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
    );
  }
);

Checkbox.displayName = "Checkbox";
