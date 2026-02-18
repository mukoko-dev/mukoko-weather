"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FooterStats {
  locations: number;
  provinces: number;
  stars: number;
}

export function Footer() {
  const year = new Date().getFullYear();
  const [stats, setStats] = useState<FooterStats>({ locations: 90, provinces: 10, stars: 0 });

  useEffect(() => {
    fetch("/api/locations?mode=stats")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.locations && data?.provinces) {
          setStats((prev) => ({ ...prev, locations: data.locations, provinces: data.provinces }));
        }
      })
      .catch(() => { /* use defaults */ });

    fetch("https://api.github.com/repos/nyuchitech/mukoko-weather", {
      headers: { Accept: "application/vnd.github.v3+json" },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (typeof data?.stargazers_count === "number") {
          setStats((prev) => ({ ...prev, stars: data.stargazers_count }));
        }
      })
      .catch(() => { /* stars stay at 0, button still works */ });
  }, []);

  const linkClass = "inline-flex items-center underline transition-colors hover:text-text-secondary";

  return (
    <footer
      className="border-t border-text-tertiary/10 bg-surface-base pb-14 sm:pb-0"
      role="contentinfo"
    >
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:px-8">
        {/* Site stats strip */}
        <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-text-tertiary/10 pb-6">
          <div className="flex items-center gap-2 text-text-tertiary">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span><strong className="text-text-secondary">{stats.locations}</strong> locations</span>
          </div>
          <div className="flex items-center gap-2 text-text-tertiary">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 3v18" />
            </svg>
            <span><strong className="text-text-secondary">{stats.provinces}</strong> provinces</span>
          </div>
          <div className="flex items-center gap-2 text-text-tertiary">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3v18h18" />
              <path d="m19 9-5 5-4-4-3 3" />
            </svg>
            <Link href="/history" prefetch={false} className={linkClass}>
              Historical data
            </Link>
          </div>
          <a
            href="https://github.com/nyuchitech/mukoko-weather"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-2 rounded-full border border-text-tertiary/20 bg-surface-card px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            Star{stats.stars > 0 && <span className="tabular-nums">{stats.stars}</span>}
          </a>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="text-text-tertiary">
              &copy; {year}{" "}
              <a href="https://nyuchi.com" className="underline transition-colors hover:text-text-secondary" rel="noopener">
                Nyuchi Africa (PVT) Ltd
              </a>
              . A Mukoko Africa product.
            </p>
            <p className="text-text-tertiary">
              Weather data by{" "}
              <a href="https://www.tomorrow.io" className="underline transition-colors hover:text-text-secondary" rel="noopener noreferrer">
                Tomorrow.io
              </a>
              {" & "}
              <a href="https://open-meteo.com" className="underline transition-colors hover:text-text-secondary" rel="noopener noreferrer">
                Open-Meteo
              </a>
              .
            </p>
            <p className="text-text-tertiary">
              Built with Ubuntu philosophy — weather as a public good.
            </p>
          </div>
          <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-5 gap-y-1 text-text-tertiary">
            <Link href="/about" prefetch={false} className={linkClass}>About</Link>
            <Link href="/explore" prefetch={false} className={linkClass}>Explore</Link>
            <Link href="/history" prefetch={false} className={linkClass}>History</Link>
            <Link href="/status" prefetch={false} className={linkClass}>Status</Link>
            <Link href="/privacy" prefetch={false} className={linkClass}>Privacy</Link>
            <Link href="/terms" prefetch={false} className={linkClass}>Terms</Link>
            <Link href="/help" prefetch={false} className={linkClass}>Help</Link>
            <a href="mailto:support@mukoko.com" className={linkClass}>Contact</a>
            <a
              href="https://github.com/nyuchitech/mukoko-weather/issues/new/choose"
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Report an Issue
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
