"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { attachSheetDrag } from "@/lib/sheet-drag";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-overlay",
        className,
      )}
      {...props}
    />
  );
}

interface DialogContentProps extends React.ComponentProps<
  typeof DialogPrimitive.Content
> {
  /**
   * The title, pinned in the top bar beside Close. It is the dialog's
   * accessible name (Radix labels the dialog by it). Leave it out only when
   * the content brings its own `DialogTitle`.
   */
  heading?: React.ReactNode;
  /** Classes for the pinned title (a label style, say). */
  headingClassName?: string;
  /** Controls between the title and Close, such as My Weather's Apply. */
  actions?: React.ReactNode;
}

/**
 * The one modal and bottom sheet (issue #482), so no modal carries its own
 * copy of any of this:
 *
 * - A pinned top bar: the grab pill (phones), the title, `actions` and the
 *   round Close control at the top right (`aria-label="Close"`, the 49px hit
 *   region of `.duiker` and the `--float-border` hairline). Escape and an
 *   outside tap still close it too. The bar stays put while the content
 *   scrolls.
 * - Pull down to dismiss on phones (`attachSheetDrag`, src/lib/sheet-drag.ts):
 *   the sheet follows the finger from the bar, or from the content while it is
 *   at its top, and closes by clicking its own Close control, so Radix's focus
 *   trap, scroll lock and return-focus all run as for any other close.
 * - Corners that follow the screen: `--radius-screen` on a phone (a local
 *   token, see globals.css), `--radius-card` from `sm`, where it is a centred
 *   dialog.
 * - The home-indicator inset under the content on a phone.
 */
function DialogContent({
  className,
  children,
  heading,
  headingClassName,
  actions,
  ref,
  ...props
}: DialogContentProps) {
  // A ref callback with a cleanup (React 19): the listeners live exactly as
  // long as the content node, and the caller's own `ref` still works.
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
      if (!node) return;
      const detach = attachSheetDrag(node, {
        dismiss: () =>
          node.querySelector<HTMLElement>("[data-sheet-close]")?.click(),
      });
      return () => {
        detach();
        if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={attach}
        data-slot="dialog-content"
        className={cn(
          "bg-surface-card fixed z-50 w-full shadow-lg duration-200 overscroll-y-contain",
          // Phone: a bottom sheet that slides up from the bottom. Its top
          // corners follow the screen's; it stops short of the status bar.
          "inset-x-0 bottom-0 max-h-[calc(100dvh-var(--float-top))] overflow-y-auto rounded-t-[var(--radius-screen)] data-[state=open]:animate-slide-up data-[state=closed]:animate-slide-down",
          // From sm: a centred dialog.
          "sm:inset-auto sm:top-[50%] sm:left-[50%] sm:bottom-auto sm:translate-x-[-50%] sm:translate-y-[-50%] sm:max-w-lg sm:rounded-[var(--radius-card)] sm:data-[state=open]:animate-in sm:data-[state=open]:fade-in-0 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:animate-out sm:data-[state=closed]:fade-out-0 sm:data-[state=closed]:zoom-out-95 sm:max-h-[85vh]",
          className,
        )}
        {...props}
      >
        <DialogBar
          heading={heading}
          headingClassName={headingClassName}
          actions={actions}
        />
        {children}
        {/* The home-indicator inset: content never ends under it. */}
        <div
          aria-hidden="true"
          data-slot="dialog-safe-area"
          className="h-[env(safe-area-inset-bottom,0px)] shrink-0 sm:hidden"
        />
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * The pinned top bar of every modal: grab pill (phones only), title, actions,
 * Close, and the minerals accent as its divider. `sticky top-0` (with a
 * matching background) keeps it in view while DialogContent, the scroll
 * container, scrolls; `touch-none` makes it a handle the browser never takes
 * for a scroll, so a pull on it always moves the sheet (see sheet-drag.ts).
 *
 * In Bundu-floor terms: the row is the 49px hit region of Close, the gaps
 * between its controls are the 7px floor, the title keeps the card inset from
 * the edge, and Close sits 7px from the corner, where it still lies inside the
 * sheet's curve (the screen radius is more than 7px plus half the control).
 */
function DialogBar({
  heading,
  headingClassName,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  heading?: React.ReactNode;
  headingClassName?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="dialog-bar"
      data-sheet-drag=""
      className={cn(
        // pt, not a margin on the row: a margin would collapse out of the bar,
        // and a stuck bar (content scrolled) would lose its 7px at the top.
        "sticky top-0 z-10 shrink-0 touch-none bg-surface-card pt-[var(--gap-floor)]",
        className,
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-2 flex justify-center sm:hidden"
      >
        <div className="h-1 w-10 rounded-full bg-[color:var(--float-border)]" />
      </div>
      <div className="flex h-[var(--touch-target-min)] items-center gap-[var(--gap-floor)] ps-[var(--space-card)] pe-[var(--gap-floor)]">
        {heading ? (
          <DialogTitle
            className={cn("min-w-0 flex-1 truncate", headingClassName)}
          >
            {heading}
          </DialogTitle>
        ) : (
          <span className="flex-1" />
        )}
        {actions}
        <DialogPrimitive.Close
          data-slot="dialog-close"
          data-sheet-close=""
          aria-label="Close"
          className="duiker border-solid border-[length:var(--border-width-rest)] border-[color:var(--float-border)] text-text-primary"
        >
          <X size={20} aria-hidden="true" />
        </DialogPrimitive.Close>
      </div>
      <div className="minerals-accent mx-4 mt-[var(--gap-floor)] sm:mx-5" />
    </div>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-lg font-semibold text-text-primary font-heading",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-base text-text-secondary", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBar,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
