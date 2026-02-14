import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";

export default function Loading() {
  return (
    <div className="min-h-screen bg-background">
      <HeaderSkeleton />

      {/* Centered loading indicator */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 pt-32">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
        </div>
        <p className="mt-4 text-sm text-text-tertiary">Loading...</p>
      </div>
    </div>
  );
}
