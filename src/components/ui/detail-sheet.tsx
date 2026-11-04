"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DetailSheetProps {
  /** Closed sheets render nothing. */
  open: boolean;
  /** The accessible name of the dialog (Radix labels it by this title). */
  title: string;
  onClose: () => void;
  /** Rendered under the title bar (headline, summary). */
  header?: ReactNode;
  /** Plain-language description; becomes the dialog's accessible description. */
  description?: ReactNode;
  /** Where focus goes on close; defaults to Radix's own return to the opener. */
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
}

const DESCRIPTION_ID = "detail-sheet-about";

/**
 * The one detail sheet: a bottom sheet on phones, a centred dialog from `sm`
 * (the shared Dialog does both). The shared DialogContent gives it the pinned
 * title bar with the Close control at the top right, the pull down to dismiss
 * and the screen-radius corners; Radix traps focus inside, closes on Escape and
 * returns focus to the opener. The full-width Close at the foot stays for the
 * thumb. Used by the Conditions tiles (MetricDetailModal) and by the activity
 * advice (ActivitiesDetailSheet).
 */
export function DetailSheet({
  open,
  title,
  onClose,
  header,
  description,
  returnFocusTo,
  children,
}: DetailSheetProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        heading={title}
        headingClassName="hornbill text-sm"
        aria-describedby={description ? DESCRIPTION_ID : undefined}
        className="pb-6"
        onCloseAutoFocus={
          returnFocusTo
            ? (event) => {
                event.preventDefault();
                returnFocusTo.focus();
              }
            : undefined
        }
      >
        <div className="flex flex-col gap-[var(--space-section)] px-4 pt-3 sm:px-5">
          {header && <header className="flex flex-col gap-1">{header}</header>}
          {children}
          {description && (
            <DialogDescription id={DESCRIPTION_ID}>
              {description}
            </DialogDescription>
          )}
          <DialogClose asChild>
            <Button variant="outline" className="w-full">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
