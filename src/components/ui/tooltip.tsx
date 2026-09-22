import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      data-geist-tooltip=""
      className={cn(          "intab-tooltip z-50 overflow-hidden px-2.5 py-1 text-xs font-medium",
        "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border border-[var(--ds-gray-alpha-400)] rounded-md shadow-[var(--ds-shadow-tooltip)] select-none",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

export function SimpleTooltip({
  content,
  shortcut,
  children,
  side = "top",
  delayDuration = 150,
  className,
}: {
  content: React.ReactNode;
  shortcut?: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
  /** Extra classes for the bubble — omit the short-tooltip defaults */
  className?: string;
}) {
  if (!content && !shortcut) return <>{children}</>;

  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className={className}>
        <span className="flex items-center gap-1.5">
          {content && <span>{content}</span>}
          {shortcut && (
            <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 rounded bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-alpha-400)] text-[10px] font-mono font-medium leading-none">
              {shortcut}
            </kbd>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
