"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FooterStats {
  locations: number;
  provinces: number;
}

export function Footer() {
  const year = new Date().getFullYear();
  const [stats, setStats] = useState<FooterStats>({ locations: 90, provinces: 10 });

  useEffect(() => {
    fetch("/api/locations?mode=stats")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.locations && data?.provinces) {
          setStats({ locations: data.locations, provinces: data.provinces });
        }
      })
      .catch(() => { /* use defaults */ });
  }, []);

  const linkClass = "inline-flex items-center underline transition-colors hover:text-text-secondary";

  return (
    <footer
      className="border-t border-text-tertiary/10 bg-surface-base"
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
