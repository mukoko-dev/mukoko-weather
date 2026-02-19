import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";

export default function CountryNotFound() {
  return (
    <>
      <Header />
      <main
        id="main-content"
        className="mx-auto flex max-w-5xl flex-col items-center justify-center px-4 py-24 text-center"
      >
        <h1 className="font-heading text-3xl font-bold text-text-primary">
          Country not found
        </h1>
        <p className="mt-4 max-w-md text-text-secondary">
          We don&apos;t have weather data for this country yet. Try browsing all supported countries.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <Button asChild size="lg">
            <Link href="/explore/country">Browse all countries</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/explore">Back to Explore</Link>
          </Button>
        </div>
      </main>
      <Footer />
    </>
  );
}
