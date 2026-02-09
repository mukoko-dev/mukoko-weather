export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer
      className="border-t border-text-tertiary/10 bg-surface-base"
      role="contentinfo"
    >
      <div className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8">
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
          <p className="text-xs text-text-tertiary">
            &copy; {year}{" "}
            <a href="https://nyuchi.com" className="underline hover:text-text-secondary transition-colors" rel="noopener">
              Nyuchi Africa
            </a>
            . Weather data by{" "}
            <a href="https://open-meteo.com" className="underline hover:text-text-secondary transition-colors" rel="noopener noreferrer">
              Open-Meteo
            </a>
            .
          </p>
          <p className="text-xs text-text-tertiary">
            Built with Ubuntu philosophy — weather as a public good.
          </p>
        </div>
      </div>
    </footer>
  );
}
