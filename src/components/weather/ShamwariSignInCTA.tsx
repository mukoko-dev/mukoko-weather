"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "@/lib/weather-icons";

/**
 * Accent tokens per call site. Static class strings only — Tailwind cannot
 * see dynamically built class names.
 */
const ACCENTS = {
  sodalite: {
    icon: "text-mineral-sodalite",
    surface: "border-mineral-sodalite/25 border-l-mineral-sodalite",
  },
  tanzanite: {
    icon: "text-tanzanite",
    surface: "border-tanzanite/25 border-l-tanzanite",
  },
} as const;

interface ShamwariSignInCTAProps {
  /** Card heading, e.g. "Shamwari Weather Insight". */
  title: string;
  /** One-line explanation shown under the heading. */
  body: string;
  accent: keyof typeof ACCENTS;
}

/**
 * Sign-in prompt shown to anonymous visitors in place of Shamwari AI output.
 * Uses the `.baobab` fauna surface and `.kudu-sm` button; returns the visitor
 * to the current page after sign-in.
 */
export function ShamwariSignInCTA({
  title,
  body,
  accent,
}: ShamwariSignInCTAProps) {
  const pathname = usePathname() ?? "/";
  const href = `/auth/signin?returnTo=${encodeURIComponent(pathname)}`;
  const tone = ACCENTS[accent];
  return (
    <section aria-label={title}>
      <div className={`baobab border-l-[6px] ${tone.surface}`}>
        <div className="flex items-center gap-2">
          <SparklesIcon size={16} className={tone.icon} />
          <h2 className="giraffe">{title}</h2>
        </div>
        <p className="gazelle mt-3">{body}</p>
        <div className="mt-4">
          <Link href={href} prefetch={false} className="kudu-sm">
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
