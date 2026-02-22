import { ChatSkeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";

export default function ShamwariLoading() {
  return (
    <>
      <Header />
      <main
        aria-label="Loading Shamwari"
        className="flex flex-col h-[calc(100dvh-3.5rem)] pb-[4.5rem] sm:pb-0"
      >
        <div className="mx-auto w-full max-w-3xl flex-1 min-h-0" role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading Shamwari chat...</span>
          <ChatSkeleton className="h-full" />
        </div>
      </main>
    </>
  );
}
