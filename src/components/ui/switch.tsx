import * as React from "react";
import { cn } from "@/lib/utils";
export { Toggle, Toggle as Switch, type ToggleProps } from "./toggle";

/* ============================================================
   Geist Segmented Switch (Mutually Exclusive Options)
   ============================================================ */

export interface SwitchOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedSwitchProps<T extends string = string> {
  options: SwitchOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}

export function SegmentedSwitch<T extends string = string>({
  options,
  value: controlledValue,
  defaultValue,
  onValueChange,
  size = "md",
  className,
  disabled = false,
}: SegmentedSwitchProps<T>) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState<T>(
    defaultValue ?? (options[0]?.value as T)
  );

  const isControlled = controlledValue !== undefined;
  const activeValue = isControlled ? controlledValue : uncontrolledValue;

  const handleSelect = (val: T) => {
    if (disabled) return;
    if (!isControlled) {
      setUncontrolledValue(val);
    }
    onValueChange?.(val);
  };

  return (
    <div
      role="radiogroup"
      data-geist-switch=""
      className={cn(
        "inline-flex items-center bg-[var(--ds-background-100)] p-1 rounded-[6px] border border-[var(--ds-gray-alpha-400)] select-none",
        size === "sm" ? "h-8 text-xs" : "h-9 text-sm",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      {options.map((option) => {
        const isSelected = activeValue === option.value;
        const isDisabled = disabled || option.disabled;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={isDisabled}
            onClick={() => handleSelect(option.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 h-full px-3 font-medium rounded-[4px] transition-all duration-150 cursor-pointer outline-none whitespace-nowrap",
              "focus-visible:shadow-[var(--ds-focus-ring)] disabled:cursor-not-allowed",
              isSelected
                ? "bg-[var(--ds-gray-200)] text-[var(--ds-gray-1000)] shadow-xs font-semibold"
                : "text-[var(--ds-gray-900)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-100)]"
            )}
          >
            {option.icon && (
              <span className="inline-flex items-center shrink-0">
                {option.icon}
              </span>
            )}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
