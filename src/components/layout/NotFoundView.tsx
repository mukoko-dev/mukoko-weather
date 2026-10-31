import * as React from "react";
import Link from "next/link";

import { PageShell } from "@/components/layout/PageShell";

export interface NotFoundAction {
  href: string;
  label: string;
  /** The one primary action (kudu); everything else is secondary (impala). */
  primary?: boolean;
}

/** The two ways out of a missing place or area, shared by every explore not-found. */
export const EXPLORE_NOT_FOUND_ACTIONS: NotFoundAction[] = [
  { href: "/explore/country", label: "Browse all countries", primary: true },
  { href: "/explore", label: "Back to Explore" },
];

/**
 * The one not-found layout. It sits inside PageShell, so the header, footer,
 * skip-link target and the mobile-nav bottom clearance all match every other
 * page. Callers pass only their copy and actions.
 */
export function NotFoundView({
  headingId = "not-found-heading",
  title,
  message,
  children,
  actions = [],
}: {
  headingId?: string;
  title: string;
  message: React.ReactNode;
  /** Extra content under the message (for example the city suggestions). */
  children?: React.ReactNode;
  actions?: NotFoundAction[];
}) {
  return (
    <PageShell width="prose" className="flex flex-col items-center text-center">
      <section
        aria-labelledby={headingId}
        className="flex w-full flex-col items-center"
      >
        <h1 id={headingId} className="elephant">
          {title}
        </h1>
        <p className="gazelle mt-4 max-w-md">{message}</p>
        {children}
        {actions.length > 0 && (
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            {actions.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className={action.primary ? "kudu" : "impala"}
              >
                {action.label}
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}

/**
 * The explore not-found page: the shared actions, with only the copy varying.
 * The country and province not-found routes are thin wrappers over it.
 */
export function ExploreNotFound({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <NotFoundView
      title={title}
      message={message}
      actions={EXPLORE_NOT_FOUND_ACTIONS}
    />
  );
}
