"use client";

import Image from "next/image";
import Link from "next/link";
import { isFeatureEnabled } from "@/lib/feature-flags";

export function Footer() {
  const year = new Date().getFullYear();
  const shamwariEnabled = isFeatureEnabled("shamwari_chat");

  const col = "flex flex-col gap-1";
  const heading =
    "mb-2 text-xs font-semibold uppercase tracking-widest text-text-tertiary";
  const link =
    "text-base text-text-secondary transition-colors hover:text-text-primary";

  return (
    <footer
      className="border-t border-text-tertiary/10 bg-surface-base pb-24 sm:pb-0"
      role="contentinfo"
    >
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 md:px-8">
        {/* ── Main columns ── */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-4">
          {/* Brand */}
          <div className={`${col} col-span-2 sm:col-span-1`}>
            <Link
              href="/"
              className="flex items-center gap-2"
              aria-label="mukoko weather home"
            >
              <Image
                src="/logo-light.svg"
                alt="mukoko mark"
                width={28}
                height={28}
                className="h-7 w-7 dark:hidden"
              />
              <Image
                src="/logo-dark.svg"
                alt="mukoko mark"
                width={28}
                height={28}
                className="h-7 w-7 hidden dark:block"
              />
              <span className="font-heading font-bold text-text-primary">
                weather
              </span>
            </Link>
            <p className="text-base text-text-secondary leading-relaxed max-w-[220px]">
              AI-powered weather intelligence for Africa and beyond. Weather as
              a public good.
            </p>
            <div className="flex items-center gap-3 pt-1">
              <a
                href="https://twitter.com/mukokoafrica"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Twitter"
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.745l7.73-8.835L1.254 2.25H8.08l4.259 5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a
                href="https://github.com/nyuchi/mukoko-weather"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
              </a>
            </div>
          </div>

          {/* Weather */}
          <div className={col}>
            <p className={heading}>Weather</p>
            <Link href="/explore" prefetch={false} className={link}>
              Explore
            </Link>
            <Link href="/history" prefetch={false} className={link}>
              Historical data
            </Link>
            {shamwariEnabled && (
              <Link href="/shamwari" prefetch={false} className={link}>
                Shamwari AI
              </Link>
            )}
            <Link href="/aviation" prefetch={false} className={link}>
              Aviation
            </Link>
            <Link href="/embed" prefetch={false} className={link}>
              Embed widget
            </Link>
            <Link href="/developers" prefetch={false} className={link}>
              Developers &amp; API
            </Link>
            <Link href="/status" prefetch={false} className={link}>
              System status
            </Link>
          </div>

          {/* Company */}
          <div className={col}>
            <p className={heading}>Company</p>
            <Link href="/about" prefetch={false} className={link}>
              About
            </Link>
            <Link href="/help" prefetch={false} className={link}>
              Help
            </Link>
            <Link href="/privacy" prefetch={false} className={link}>
              Privacy
            </Link>
            <Link href="/terms" prefetch={false} className={link}>
              Terms
            </Link>
            <a href="mailto:support@mukoko.com" className={link}>
              Contact
            </a>
            <a
              href="https://github.com/nyuchi/mukoko-weather/issues/new/choose"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Report an issue
            </a>
          </div>

          {/* Ecosystem */}
          <div className={col}>
            <p className={heading}>Ecosystem</p>
            <a
              href="https://nyuchi.com"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Nyuchi Africa
            </a>
            <a
              href="https://mukoko.com"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Mukoko.com
            </a>
            <a
              href="https://barstool.mukoko.com"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Barstool
            </a>
          </div>
        </div>

        {/* ── Bottom bar ── */}
        <div className="mt-14 flex flex-col gap-4 border-t border-text-tertiary/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-base text-text-tertiary">
            &copy; {year} Mukoko Africa — a division of{" "}
            <a
              href="https://nyuchi.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-text-secondary"
            >
              Nyuchi Africa (PVT) Ltd
            </a>
            . <span className="italic">Ndiri nekuti tiri.</span>
          </p>
          <p className="text-sm text-text-tertiary">
            Weather data:{" "}
            <a
              href="https://www.tomorrow.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-secondary transition-colors"
            >
              Tomorrow.io
            </a>
            {" & "}
            <a
              href="https://open-meteo.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-secondary transition-colors"
            >
              Open-Meteo
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
