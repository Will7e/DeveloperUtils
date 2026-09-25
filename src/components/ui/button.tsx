import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Geist Button — aligned to vercel.com/geist/button.
 * Colors: Gray 1 default bg → Gray 2 hover → Gray 3 active (dark);
 * high-contrast action = Gray 1000; secondary = Color 4 border.
 * Typography: Button 14 (13px/500) default, Button 12 (11px/500) sm.
 * Height 32px default (spec), 24px small, 40px large.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 cursor-pointer select-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ds-gray-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-alpha-200)] hover:bg-[var(--ds-gray-200)] active:bg-[var(--ds-gray-300)]",
        secondary:
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-alpha-400)] hover:border-[var(--ds-gray-alpha-500)] hover:bg-[var(--ds-gray-alpha-100)]",
        outline:
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)] hover:border-[var(--ds-gray-500)] hover:bg-[var(--ds-gray-100)]",
        destructive:
          "bg-[var(--ds-red-800)] text-white border border-transparent hover:bg-[var(--ds-red-900)]",
        warning:
          "bg-[var(--ds-amber-800)] text-[var(--ds-background-100)] border border-transparent hover:bg-[var(--ds-amber-900)]",
        ghost:
          "bg-transparent text-[var(--ds-gray-900)] border border-transparent hover:bg-[var(--ds-gray-alpha-200)] hover:text-[var(--ds-gray-1000)]",
        link: "text-[var(--ds-blue-700)] underline-offset-4 hover:underline bg-transparent border-none p-0 h-auto",
        glow:
          "bg-[var(--ds-blue-700)] text-white border border-transparent hover:bg-[var(--ds-blue-800)]",
        primary:
          "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border border-transparent hover:opacity-90",
      },
      size: {
        default: "h-8 px-3.5 text-[13px]",
        sm: "h-6 px-2 text-[11px] gap-1 [&_svg]:size-3",
        lg: "h-10 px-5 text-sm rounded-[var(--radius-md)]",
        xl: "h-12 px-7 text-base rounded-[var(--radius-md)]",
        icon: "h-8 w-8 p-0",
        "icon-sm": "h-6 w-6 p-0 [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
