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
            &copy; {year} Nyuchi Africa. Weather data by Open-Meteo.
          </p>
          <p className="text-xs text-text-tertiary">
            Built with Ubuntu philosophy — weather as a public good.
          </p>
        </div>
      </div>
    </footer>
  );
}
