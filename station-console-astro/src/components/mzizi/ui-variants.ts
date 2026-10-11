/**
 * The class recipes behind the primitives, with no React in them, so the
 * React components (`./button.tsx`, …) and the pure Astro app components
 * (`../app/*.astro`) share one source. Each `.tsx` re-exports its recipe,
 * so `import { buttonVariants } from "@bundu/ui/ui/button"` still works.
 */
import { cva } from "class-variance-authority";

/** Skeleton — a loading placeholder on the `muted` token. */
export const skeletonClasses = "animate-pulse rounded-md bg-muted";

/** Alert title and description, as `AlertTitle` / `AlertDescription` render them. */
export const alertTitleClasses = "mb-1 font-medium leading-none";
export const alertDescriptionClasses =
  "text-body-sm [&_p]:leading-relaxed opacity-90";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium rounded-full transition-all duration-200 ease-soft outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-foreground text-background hover:opacity-90",
        outline:
          "border border-foreground text-foreground hover:bg-foreground hover:text-background",
        ghost: "text-foreground hover:bg-muted",
        // Danger is never a brand colour: only the destructive tokens,
        // whatever brand overlay is active. The label must say what is
        // destroyed; colour is never the only signal.
        destructive:
          "bg-destructive text-destructive-foreground hover:opacity-90",
        "destructive-outline":
          "border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground",
      },
      size: {
        sm: "h-12 px-4 text-body-sm",
        md: "h-12 px-6 text-body",
        lg: "h-14 px-8 text-body-lg",
      },
      fullWidth: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export const cardVariants = cva("card", {
  variants: {
    padding: {
      none: "",
      sm: "p-4",
      md: "p-6",
      lg: "p-8",
    },
    hover: {
      true: "card-hover",
    },
  },
  defaultVariants: {
    padding: "md",
  },
});

export const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-body-sm",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground border-border",
        info: "bg-cobalt-container text-cobalt-on-container border-transparent",
        success:
          "bg-malachite-container text-malachite-on-container border-transparent",
        warning: "bg-gold-container text-gold-on-container border-transparent",
        destructive: "bg-card text-destructive border-destructive/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export const inputClasses =
  "flex h-12 w-full rounded-lg border border-border bg-background px-4 text-body text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed";

export const labelClasses = "text-body-sm font-medium text-foreground";

/*
 * App density (0.3.0). Consoles and signed-in apps are dense, not
 * marketing-roomy: 36px controls and 14px text on a fine pointer, growing
 * to 48px targets and 16px text on a coarse pointer (touch), so phones keep
 * WCAG-sized targets and iOS never zooms an input. Corners are the small
 * radius, not the marketing pill. The app components (`../app/*.astro`)
 * use these; the marketing primitives above are unchanged.
 */
export const appButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium rounded-sm border border-transparent transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        // The shell's accent (AppShell `accent`, a mineral's brand fill)
        // when set, else the theme's primary.
        primary:
          "bg-[var(--app-accent,var(--primary))] text-[var(--app-accent-foreground,var(--primary-foreground))] hover:opacity-90",
        secondary: "bg-foreground text-background hover:opacity-90",
        outline: "border-border bg-card text-foreground hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        /** The one irreversible action on a page (e.g. "Delete my account"). */
        destructive:
          "bg-destructive text-destructive-foreground hover:opacity-90",
        /** A secondary destructive action in a list or panel (revoke, remove). */
        "destructive-outline":
          "border-destructive bg-card text-destructive hover:bg-destructive hover:text-destructive-foreground",
      },
      size: {
        sm: "h-8 px-3 text-body-sm pointer-coarse:h-11 pointer-coarse:px-4",
        md: "h-9 px-3.5 text-body-sm pointer-coarse:h-12 pointer-coarse:px-5 pointer-coarse:text-body",
        lg: "h-10 px-4 text-body pointer-coarse:h-12 pointer-coarse:px-6",
      },
      fullWidth: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

/** A dense app input or select: 36px, 48px on touch. */
export const appInputClasses =
  "flex h-9 w-full min-w-0 rounded-sm border border-border bg-card px-3 text-body-sm text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:cursor-not-allowed pointer-coarse:h-12 pointer-coarse:text-body";

/**
 * Badge, to the Mzizi registry's `badge` contract (`badge.tsx` / `badge.rs`
 * in mzizi-dev/mzizi-registry, N2): the same six variants, the same
 * `data-slot` / `data-variant`, and the same classes, so one stylesheet
 * serves the React, Rust and Astro builds. The Astro `app/Badge.astro`
 * uses it. The React `./badge.tsx` keeps its own mineral variants.
 */
export const BADGE_VARIANTS = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "ghost",
  "link",
] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

const badgeBase =
  "h-5 gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive overflow-hidden group/badge";

const badgeVariantClasses: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
  secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
  destructive:
    "bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
  outline:
    "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/30",
  ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
  link: "text-primary underline-offset-4 hover:underline",
};

/** The full class string for a registry-contract badge (`badge_variants` in `badge.rs`). */
export function badgeClasses(
  variant: BadgeVariant = "default",
  extra = "",
): string {
  return [badgeBase, badgeVariantClasses[variant], extra]
    .filter(Boolean)
    .join(" ");
}

/**
 * A dense app textarea: the app input's border, fill, type and focus ring,
 * with its height from `rows` above a floor of 80px (96px on touch), so it is
 * never a 36px strip.
 */
export const appTextareaClasses =
  "flex min-h-20 w-full min-w-0 rounded-sm border border-border bg-card px-3 py-2 text-body-sm text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:cursor-not-allowed pointer-coarse:min-h-24 pointer-coarse:text-body";

/**
 * Added to `appInputClasses` for a file input: its height follows the
 * file-selector button, which is a muted pill.
 */
export const appFileInputClasses =
  "h-auto py-2 pointer-coarse:h-auto file:me-4 file:rounded-full file:border-0 file:bg-muted file:px-4 file:py-1.5 file:text-body-sm file:font-medium file:text-foreground";

/**
 * A status pill: the badge's shape in a fixed status colour, for a table cell
 * or a list that says a record's state (active, pending, failed). The tones
 * are the mineral container pairs, the same in every brand; `neutral` is
 * muted. A component that renders one declares the minerals in its
 * contract's `theming.statusColours`.
 */
export const STATUS_TONES = [
  "neutral",
  "success",
  "warning",
  "info",
  "accent",
  "premium",
] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

const statusToneBase =
  "inline-flex h-5 w-fit shrink-0 items-center justify-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium";

const statusToneVariantClasses: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-malachite-container text-malachite-on-container",
  warning: "bg-gold-container text-gold-on-container",
  info: "bg-cobalt-container text-cobalt-on-container",
  accent: "bg-terracotta-container text-terracotta-on-container",
  premium: "bg-tanzanite-container text-tanzanite-on-container",
};

/** The full class string for a status pill of one tone. */
export function statusToneClasses(
  tone: StatusTone = "neutral",
  extra = "",
): string {
  return [statusToneBase, statusToneVariantClasses[tone], extra]
    .filter(Boolean)
    .join(" ");
}
