import { MukokoLogo } from "@/components/brand/MukokoLogo";

export function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-30 border-b border-text-tertiary/10 bg-surface-base/80 backdrop-blur-md" role="banner" aria-label="Loading header">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 md:px-8">
        <MukokoLogo className="text-xl sm:text-2xl" />
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 p-1" aria-hidden="true">
          <div className="h-14 w-14 rounded-full" />
          <div className="h-14 w-14 rounded-full" />
          <div className="h-14 w-14 rounded-full" />
        </div>
      </div>
    </header>
  );
}
