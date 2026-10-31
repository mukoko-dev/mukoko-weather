/**
 * One grouped section of the profile page: a plain muted heading above one
 * rounded card (`.guineafowl` wrapper, `.guineafowl-heading`,
 * `.guineafowl-card`). The heading's `id` labels the section.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ProfileGroup({
  id,
  title,
  cardClassName,
  children,
}: {
  id: string;
  title: string;
  cardClassName?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="guineafowl">
      <h2 id={id} className="guineafowl-heading">
        {title}
      </h2>
      <div className={cn("guineafowl-card", cardClassName)}>{children}</div>
    </section>
  );
}
