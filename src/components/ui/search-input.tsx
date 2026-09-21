import * as React from "react";
import { Search, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: "sm" | "md" | "lg";
  shortcut?: string;
  loading?: boolean;
  prefix?: React.ReactNode;
  onClear?: () => void;
  wrapperClassName?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      size = "md",
      shortcut,
      loading = false,
      prefix,
      value: controlledValue,
      defaultValue = "",
      onChange,
      onClear,
      placeholder = "Search...",
      disabled = false,
      className,
      wrapperClassName,
      ...props
    },
    ref
  ) => {
    const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : uncontrolledValue;
    const hasValue = Boolean(value && String(value).length > 0);

    const inputRef = React.useRef<HTMLInputElement | null>(null);

    const handleCombinedRef = (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setUncontrolledValue(e.target.value);
      }
      onChange?.(e);
    };

    const handleClear = () => {
      if (!isControlled) {
        setUncontrolledValue("");
      }
      if (inputRef.current) {
        inputRef.current.value = "";
        const syntheticEvent = new Event("input", { bubbles: true });
        inputRef.current.dispatchEvent(syntheticEvent);
      }
      onClear?.();
      inputRef.current?.focus();
    };

    return (
      <div
        data-geist-input-wrapper=""
        className={cn(
          "group/search relative flex items-center w-full transition-all duration-150 overflow-hidden font-normal rounded-md",
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)]",
          "shadow-[0_0_0_1px_var(--ds-gray-alpha-400)] hover:shadow-[0_0_0_1px_var(--ds-gray-alpha-500)]",
          "has-[:focus]:!shadow-[0_0_0_1px_var(--ds-gray-1000),0_0_0_3px_var(--ds-focus-color)]",
          disabled && "opacity-50 cursor-not-allowed bg-[var(--ds-gray-100)] hover:shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]",
          size === "sm" && "h-8 text-xs",
          size === "md" && "h-9 text-sm",
          size === "lg" && "h-10 text-base",
          wrapperClassName
        )}
      >
        {/* Prefix Icon */}
        <div
          data-geist-input-prefix=""
          className={cn(
            "flex items-center justify-center shrink-0 text-[var(--ds-gray-700)] select-none",
            size === "sm" ? "pl-2.5 pr-1.5" : "pl-3 pr-2"
          )}
        >
          {prefix ? (
            prefix
          ) : (
            <Search
              className={cn(
                "shrink-0",
                size === "sm" ? "size-3.5" : size === "md" ? "size-4" : "size-4.5"
              )}
            />
          )}
        </div>

        {/* Input */}
        <input
          ref={handleCombinedRef}
          type="text"
          value={value}
          onChange={handleChange}
          disabled={disabled}
          placeholder={placeholder}
          data-geist-input=""
          aria-invalid="false"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          className={cn(
            "w-full h-full bg-transparent border-0 outline-none px-1 text-[var(--ds-gray-1000)] placeholder:text-[var(--ds-gray-700)] font-sans font-normal",
            "disabled:cursor-not-allowed disabled:text-[var(--ds-gray-700)]",
            className
          )}
          {...props}
        />

        {/* Suffix (Loading / Clear / Shortcut) */}
        <div
          data-geist-input-suffix=""
          className={cn(
            "flex items-center gap-1.5 shrink-0 select-none",
            size === "sm" ? "pr-2" : "pr-2.5"
          )}
        >
          {loading && (
            <Loader2
              className={cn(
                "animate-spin text-[var(--ds-gray-700)]",
                size === "sm" ? "size-3.5" : "size-4"
              )}
            />
          )}

          {!loading && hasValue && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              tabIndex={-1}
              className="flex items-center justify-center rounded p-0.5 text-[var(--ds-gray-700)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-200)] transition-colors cursor-pointer outline-none"
            >
              <X className={size === "sm" ? "size-3" : "size-3.5"} />
            </button>
          )}

          {shortcut && !hasValue && (
            <kbd className="inline-flex items-center justify-center font-sans text-[11px] font-medium h-5 px-1.5 rounded bg-[var(--ds-background-100)] text-[var(--ds-gray-700)] border border-[var(--ds-gray-alpha-400)] shadow-xs pointer-events-none">
              {shortcut}
            </kbd>
          )}
        </div>
      </div>
    );
  }
);
SearchInput.displayName = "SearchInput";
