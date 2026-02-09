"use client";

import Link from "next/link";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { ThemeToggle } from "@/components/brand/ThemeToggle";
import { LocationSelector } from "@/components/weather/LocationSelector";

interface Props {
  currentLocation: string;
}

export function Header({ currentLocation }: Props) {
  return (
    <header
      className="sticky top-0 z-30 border-b border-text-tertiary/10 bg-surface-base/80 backdrop-blur-md"
      role="banner"
    >
      <nav aria-label="Primary navigation" className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:pl-6 md:pl-8">
        <div className="flex min-w-0 shrink items-center gap-4">
          <Link href="/" aria-label="mukoko weather — return to home page">
            <MukokoLogo className="text-lg sm:text-xl" />
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LocationSelector currentSlug={currentLocation} />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
