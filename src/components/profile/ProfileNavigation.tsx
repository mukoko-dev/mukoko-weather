/**
 * Every main destination in the app, on the page a user already treats as
 * "settings" — Mukoko ecosystem profile standard (mukoko-news
 * `src/components/profile/profile-navigation.tsx`; mukoko-events renders the
 * same grouped rows as its Events / Account / Support menu sections).
 *
 * On a phone the header shows only a handful of destinations, so this is the
 * one-tap "where can I go" surface. Groups render as `.guineafowl` cards.
 */

import Link from "next/link";
import {
  ChevronRight,
  Clock,
  Code2,
  Compass,
  FileText,
  HelpCircle,
  Info,
  KeyRound,
  MapPin,
  Plane,
  Shield,
  Activity,
  CloudSun,
  type LucideIcon,
} from "lucide-react";

export interface ProfileDestination {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  group: ProfileNavGroupId;
}

export type ProfileNavGroupId = "weather" | "developers" | "about";

export const PROFILE_NAV_GROUPS: { id: ProfileNavGroupId; label: string }[] = [
  { id: "weather", label: "Weather" },
  { id: "developers", label: "Developers" },
  { id: "about", label: "About" },
];

export const PROFILE_DESTINATIONS: ProfileDestination[] = [
  {
    href: "/",
    label: "My location",
    description: "Weather where you are right now",
    icon: CloudSun,
    group: "weather",
  },
  {
    href: "/locations",
    label: "Saved locations",
    description: "The places you follow",
    icon: MapPin,
    group: "weather",
  },
  {
    href: "/explore",
    label: "Explore",
    description: "Browse places by category and country",
    icon: Compass,
    group: "weather",
  },
  {
    href: "/history",
    label: "History",
    description: "Recorded weather and trends",
    icon: Clock,
    group: "weather",
  },
  {
    href: "/aviation",
    label: "Aviation",
    description: "METAR, TAF and pre-flight briefings",
    icon: Plane,
    group: "weather",
  },
  {
    href: "/developers/keys",
    label: "API keys",
    description: "Create and revoke developer keys",
    icon: KeyRound,
    group: "developers",
  },
  {
    href: "/developers",
    label: "API documentation",
    description: "Build with mukoko weather data",
    icon: Code2,
    group: "developers",
  },
  {
    href: "/help",
    label: "Help Center",
    description: "Answers to common questions",
    icon: HelpCircle,
    group: "about",
  },
  {
    href: "/status",
    label: "System status",
    description: "Live health of every data source",
    icon: Activity,
    group: "about",
  },
  {
    href: "/about",
    label: "About mukoko weather",
    description: "Who builds this and why",
    icon: Info,
    group: "about",
  },
  {
    href: "/terms",
    label: "Terms of Service",
    description: "The rules for using the app",
    icon: FileText,
    group: "about",
  },
  {
    href: "/privacy",
    label: "Privacy Policy",
    description: "What we collect and why",
    icon: Shield,
    group: "about",
  },
];

export function ProfileNavigation() {
  return (
    <nav aria-label="All pages" className="mb-6">
      {PROFILE_NAV_GROUPS.map((group) => {
        const items = PROFILE_DESTINATIONS.filter((d) => d.group === group.id);
        if (items.length === 0) return null;
        const headingId = `profile-nav-${group.id}`;
        return (
          <section
            key={group.id}
            aria-labelledby={headingId}
            className="guineafowl"
          >
            <h2 id={headingId} className="guineafowl-heading">
              {group.label}
            </h2>
            <ul>
              {items.map((d) => {
                const Icon = d.icon;
                return (
                  <li
                    key={d.href}
                    className="border-b border-border last:border-b-0"
                  >
                    <Link href={d.href} className="guineafowl-row border-b-0">
                      <span className="flex min-w-0 items-center gap-3">
                        <Icon
                          className="h-5 w-5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{d.label}</span>
                          <span className="block text-xs text-text-tertiary">
                            {d.description}
                          </span>
                        </span>
                      </span>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-text-tertiary"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
