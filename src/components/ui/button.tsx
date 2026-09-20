import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ds-focus-ring)] disabled:pointer-events-none disabled:opacity-50 disabled:bg-[var(--ds-gray-100)] disabled:text-[var(--ds-gray-700)] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer select-none",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border border-transparent shadow-xs hover:opacity-90 active:scale-[0.98]",
        destructive:
          "bg-[var(--ds-red-800)] text-white border border-transparent shadow-xs hover:bg-[var(--ds-red-900)] active:scale-[0.98]",
        warning:
          "bg-[var(--ds-amber-800)] text-[#0a0a0a] border border-transparent shadow-xs hover:bg-[var(--ds-amber-900)] active:scale-[0.98]",
        outline:
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)] shadow-xs hover:bg-[var(--ds-gray-200)] active:scale-[0.98]",
        secondary:
          "bg-[var(--ds-background-100)] text-[var(--ds-gray-1000)] border border-[var(--ds-gray-400)] shadow-xs hover:bg-[var(--ds-gray-200)] active:scale-[0.98]",
        ghost:
          "bg-transparent text-[var(--ds-gray-1000)] border border-transparent hover:bg-[var(--ds-gray-alpha-200)] active:scale-[0.98]",
        link: "text-[var(--ds-blue-700)] underline-offset-4 hover:underline bg-transparent border-none p-0 h-auto",
        glow: "bg-[var(--ds-blue-700)] text-white border border-transparent shadow-[0_0_20px_rgba(0,112,243,0.35)] hover:bg-[var(--ds-blue-800)] active:scale-[0.98]",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-6 text-sm rounded-lg",
        xl: "h-12 px-8 text-base rounded-lg",
        icon: "h-9 w-9 p-0",
        "icon-sm": "h-7 w-7 p-0",
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
