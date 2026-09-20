import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

export interface SeparatorProps
  extends React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  label?: React.ReactNode;
}

const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  SeparatorProps
>(
  (
    {
      className,
      orientation = "horizontal",
      decorative = true,
      label,
      ...props
    },
    ref
  ) => {
    if (label && orientation === "horizontal") {
      return (
        <div
          role="separator"
          aria-orientation="horizontal"
          data-slot="separator"
          data-geist-separator=""
          className={cn("relative flex items-center justify-center my-4 w-full select-none", className)}
        >
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[var(--ds-gray-400)]" />
          </div>
          <span className="relative bg-[var(--ds-background-100)] px-3 text-xs font-medium text-[var(--ds-gray-700)] uppercase tracking-wider">
            {label}
          </span>
        </div>
      );
    }

    return (
      <SeparatorPrimitive.Root
        ref={ref}
        decorative={decorative}
        orientation={orientation}
        data-slot="separator"
        data-geist-separator=""
        className={cn(
          "shrink-0 bg-[var(--ds-gray-400)]",
          orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
          className
        )}
        {...props}
      />
    );
  }
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
