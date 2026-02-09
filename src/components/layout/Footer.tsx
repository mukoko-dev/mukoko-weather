import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer
      className="border-t border-text-tertiary/10 bg-surface-base"
      role="contentinfo"
    >
      <div className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">
              &copy; {year}{" "}
              <a href="https://nyuchi.com" className="underline hover:text-text-secondary transition-colors" rel="noopener">
                Nyuchi Africa (PVT) Ltd
              </a>
              . A Mukoko Africa product.
            </p>
            <p className="text-xs text-text-tertiary">
              Weather data by{" "}
              <a href="https://open-meteo.com" className="underline hover:text-text-secondary transition-colors" rel="noopener noreferrer">
                Open-Meteo
              </a>
              . Built with Ubuntu philosophy — weather as a public good.
            </p>
          </div>
          <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary">
            <Link href="/about" className="underline hover:text-text-secondary transition-colors">
              About
            </Link>
            <Link href="/privacy" className="underline hover:text-text-secondary transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="underline hover:text-text-secondary transition-colors">
              Terms
            </Link>
            <Link href="/help" className="underline hover:text-text-secondary transition-colors">
              Help
            </Link>
            <a href="mailto:support@mukoko.com" className="underline hover:text-text-secondary transition-colors">
              Contact
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
