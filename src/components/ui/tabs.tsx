import * as React from "react";
import { cn } from "@/lib/utils";

type TabsVariant = "primary" | "secondary";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs() {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs components must be used within a <Tabs />");
  }
  return context;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  variant?: TabsVariant;
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  (
    {
      value: controlledValue,
      defaultValue = "",
      onValueChange,
      variant = "primary",
      className,
      children,
      ...props
    },
    ref
  ) => {
    const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
    const isControlled = controlledValue !== undefined;
    const activeValue = isControlled ? controlledValue : uncontrolledValue;

    const handleValueChange = React.useCallback(
      (val: string) => {
        if (!isControlled) {
          setUncontrolledValue(val);
        }
        onValueChange?.(val);
      },
      [isControlled, onValueChange]
    );

    return (
      <TabsContext.Provider
        value={{
          value: activeValue,
          onValueChange: handleValueChange,
          variant,
        }}
      >
        <div ref={ref} className={cn("w-full", className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = "Tabs";

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: TabsVariant;
}

export const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, variant: overrideVariant, children, ...props }, ref) => {
    const context = useTabs();
    const variant = overrideVariant ?? context.variant;

    return (
      <div
        ref={ref}
        role="tablist"
        aria-orientation="horizontal"
        data-geist-tabs=""
        data-variant={variant}
        className={cn(
          "flex items-center select-none",
          variant === "primary" && [
            "gap-6 border-b border-[var(--ds-gray-400)] overflow-x-auto no-scrollbar",
          ],
          variant === "secondary" && [
            "inline-flex p-1 bg-[var(--ds-background-100)] rounded-lg border border-[var(--ds-gray-alpha-400)] gap-1 w-fit",
          ],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
TabsList.displayName = "TabsList";

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  icon?: React.ReactNode;
}

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  TabsTriggerProps
>(({ className, value, icon, disabled = false, children, ...props }, ref) => {
  const { value: activeValue, onValueChange, variant } = useTabs();
  const isSelected = activeValue === value;

  return (
    <button
      ref={ref}
      role="tab"
      type="button"
      data-geist-tab=""
      aria-selected={isSelected}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onValueChange(value);
      }}
      className={cn(
        "cursor-pointer outline-none flex items-center justify-center font-medium transition-all duration-150 select-none whitespace-nowrap",
        "focus-visible:shadow-[var(--ds-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && [
          "-mb-px py-3 px-0.5 border-b-2 text-sm",
          isSelected
            ? "border-b-[var(--ds-gray-1000)] text-[var(--ds-gray-1000)] font-semibold"
            : "border-b-transparent text-[var(--ds-gray-900)] hover:text-[var(--ds-gray-1000)]",
        ],
        variant === "secondary" && [
          "h-8 px-3 rounded-md text-[13px] border-0",
          isSelected
            ? "bg-[var(--ds-gray-200)] text-[var(--ds-gray-1000)] shadow-xs font-semibold"
            : "text-[var(--ds-gray-900)] hover:text-[var(--ds-gray-1000)] hover:bg-[var(--ds-gray-100)]",
        ],
        className
      )}
      {...props}
    >
      {icon && <span className="mr-2 inline-flex items-center shrink-0">{icon}</span>}
      {children}
    </button>
  );
});
TabsTrigger.displayName = "TabsTrigger";

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, children, ...props }, ref) => {
    const { value: activeValue } = useTabs();
    if (activeValue !== value) return null;

    return (
      <div
        ref={ref}
        role="tabpanel"
        tabIndex={0}
        className={cn(
          "mt-3 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)]",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
TabsContent.displayName = "TabsContent";
