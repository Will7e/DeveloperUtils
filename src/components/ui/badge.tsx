import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-medium tabular-nums select-none transition-colors duration-150 whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ds-gray-200)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)]",
        secondary:
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-900)] border border-[var(--ds-gray-400)]",
        outline:
          "bg-transparent text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)]",
        inverted:
          "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border border-transparent",
        blue:
          "bg-[var(--ds-blue-200)] text-[var(--ds-blue-900)] border border-[var(--ds-blue-400)]",
        success:
          "bg-[#002b11] text-[#50e3c2] border border-[#0f5b30]",
        green:
          "bg-[#002b11] text-[#50e3c2] border border-[#0f5b30]",
        warning:
          "bg-[var(--ds-amber-200)] text-[var(--ds-amber-900)] border border-[var(--ds-amber-400)]",
        amber:
          "bg-[var(--ds-amber-200)] text-[var(--ds-amber-900)] border border-[var(--ds-amber-400)]",
        error:
          "bg-[var(--ds-red-200)] text-[var(--ds-red-900)] border border-[var(--ds-red-400)]",
        red:
          "bg-[var(--ds-red-200)] text-[var(--ds-red-900)] border border-[var(--ds-red-400)]",
        purple:
          "bg-[var(--ds-purple-200)] text-[var(--ds-purple-900)] border border-[var(--ds-purple-400)]",
        pink:
          "bg-[var(--ds-pink-200)] text-[var(--ds-pink-900)] border border-[var(--ds-pink-400)]",
      },
      size: {
        sm: "h-5 px-2 text-[11px] gap-1",
        md: "h-6 px-2.5 text-[12px] gap-1.5",
        lg: "h-7 px-3 text-[13px] gap-2",
      },
      shape: {
        pill: "rounded-full",
        square: "rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
      shape: "pill",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  icon?: React.ReactNode;
  suffixIcon?: React.ReactNode;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      variant,
      size,
      shape,
      icon,
      suffixIcon,
      className,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <span
        ref={ref}
        data-geist-badge=""
        className={cn(badgeVariants({ variant, size, shape }), className)}
        {...props}
      >
        {icon && <span className="inline-flex items-center shrink-0">{icon}</span>}
        <span>{children}</span>
        {suffixIcon && (
          <span className="inline-flex items-center shrink-0">{suffixIcon}</span>
        )}
      </span>
    );
  }
);
Badge.displayName = "Badge";

// eslint-disable-next-line react-refresh/only-export-components
export { badgeVariants };
