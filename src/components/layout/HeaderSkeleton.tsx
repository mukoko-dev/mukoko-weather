import { MukokoLogo } from "@/components/brand/MukokoLogo";

export function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-30 border-b border-text-tertiary/10 bg-surface-base/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:pl-6 md:pl-8">
        <MukokoLogo className="text-lg sm:text-xl" />
        <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-badge)] bg-primary/10 p-1">
          <div className="h-10 w-10 rounded-full" />
          <div className="h-10 w-10 rounded-full" />
          <div className="h-10 w-10 rounded-full" />
        </div>
      </div>
    </header>
  );
}
