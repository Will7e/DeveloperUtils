import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbsProps extends React.ComponentPropsWithoutRef<"nav"> {
  separator?: React.ReactNode;
}

export const Breadcrumbs = React.forwardRef<HTMLElement, BreadcrumbsProps>(
  ({ className, ...props }, ref) => (
    <nav
      ref={ref}
      aria-label="Breadcrumb"
      data-geist-breadcrumbs=""
      className={cn("flex items-center", className)}
      {...props}
    />
  )
);
Breadcrumbs.displayName = "Breadcrumbs";

export const BreadcrumbList = React.forwardRef<
  HTMLOListElement,
  React.ComponentPropsWithoutRef<"ol">
>(({ className, ...props }, ref) => (
  <ol
    ref={ref}
    className={cn(
      "flex flex-wrap items-center gap-1.5 break-words text-sm text-[var(--ds-gray-900)] list-none p-0 m-0",
      className
    )}
    {...props}
  />
));
BreadcrumbList.displayName = "BreadcrumbList";

export const BreadcrumbItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentPropsWithoutRef<"li">
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    className={cn("inline-flex items-center gap-1.5", className)}
    {...props}
  />
));
BreadcrumbItem.displayName = "BreadcrumbItem";

export interface BreadcrumbLinkProps
  extends React.ComponentPropsWithoutRef<"a"> {
  asChild?: boolean;
}

export const BreadcrumbLink = React.forwardRef<
  HTMLAnchorElement,
  BreadcrumbLinkProps
>(({ className, ...props }, ref) => (
  <a
    ref={ref}
    className={cn(
      "transition-colors duration-150 text-[var(--ds-gray-900)] hover:text-[var(--ds-gray-1000)] no-underline outline-none rounded-xs focus-visible:shadow-[var(--ds-focus-ring)] cursor-pointer",
      className
    )}
    {...props}
  />
));
BreadcrumbLink.displayName = "BreadcrumbLink";

export const BreadcrumbPage = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    role="link"
    aria-disabled="true"
    aria-current="page"
    className={cn("font-medium text-[var(--ds-gray-1000)]", className)}
    {...props}
  />
));
BreadcrumbPage.displayName = "BreadcrumbPage";

export const BreadcrumbSeparator = ({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) => (
  <li
    role="presentation"
    aria-hidden="true"
    className={cn("text-[var(--ds-gray-700)] shrink-0 select-none", className)}
    {...props}
  >
    {children ?? (
      <svg
        viewBox="0 0 16 16"
        height="14"
        width="14"
        fill="currentColor"
        className="shrink-0"
      >
        <path
          fillRule="evenodd"
          d="m5.5 1.94.53.53 4.82 4.82a1 1 0 0 1 0 1.42l-4.82 4.82-.53.53L4.44 13l.53-.53L9.44 8 4.97 3.53 4.44 3z"
          clipRule="evenodd"
        />
      </svg>
    )}
  </li>
);
BreadcrumbSeparator.displayName = "BreadcrumbSeparator";

export const BreadcrumbEllipsis = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    role="presentation"
    aria-hidden="true"
    className={cn(
      "flex h-6 w-6 items-center justify-center text-[var(--ds-gray-700)] select-none",
      className
    )}
    {...props}
  >
    <MoreHorizontal className="h-4 w-4" />
    <span className="sr-only">More</span>
  </span>
);
BreadcrumbEllipsis.displayName = "BreadcrumbEllipsis";
