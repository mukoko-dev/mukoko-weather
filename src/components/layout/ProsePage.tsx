import type { ReactNode } from "react";

import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Body of a long-form legal or information page: the title block (with the
 * "Last updated" line when given) and the body wrapper every such page shares.
 * The caller supplies the PageShell around it.
 */
export function ProsePage({
  title,
  updated,
  children,
}: {
  title: ReactNode;
  updated?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} updated={updated} />
      <div className="mt-8 space-y-8 text-text-secondary leading-relaxed">
        {children}
      </div>
    </>
  );
}

/** A titled section inside a ProsePage (the `eland` heading, then the body). */
export function ProseSection({
  heading,
  className,
  children,
}: {
  heading: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={className}>
      <h2 className="eland">{heading}</h2>
      {children}
    </section>
  );
}
