/**
 * Every main destination in the app, once. The header, the mobile ⋯ menu, the
 * `/locations` ⋯ menu, the footer and the profile navigation all read from
 * here, so a route is renamed in one place.
 *
 * Labels are the profile's (the "where can I go" surface). A surface that
 * reads a shorter or different label sets `footerLabel`; the header and the
 * `/locations` menu use `label`. `shamwari` stays behind
 * `FLAGS.shamwari_chat` at each call site, not here.
 */

import {
  Activity,
  Clock,
  Code2,
  Compass,
  FileText,
  HelpCircle,
  Info,
  KeyRound,
  Megaphone,
  MapPin,
  Plane,
  Shield,
  CloudSun,
  type LucideIcon,
} from "lucide-react";

export type NavGroupId = "weather" | "developers" | "about";

export const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: "weather", label: "Weather" },
  { id: "developers", label: "Developers" },
  { id: "about", label: "About" },
];

export interface NavDestination {
  id: NavDestinationId;
  href: string;
  label: string;
  /** Short label for the footer, where it differs from `label`. */
  footerLabel?: string;
  description: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** Listed on the profile navigation page. */
  profile: boolean;
}

export type NavDestinationId =
  | "my-location"
  | "saved"
  | "explore"
  | "history"
  | "aviation"
  | "shamwari"
  | "embed"
  | "api-keys"
  | "developers"
  | "help"
  | "releases"
  | "status"
  | "about"
  | "terms"
  | "privacy";

export const NAV_DESTINATIONS: NavDestination[] = [
  {
    id: "my-location",
    href: "/",
    label: "My location",
    description: "Weather where you are right now",
    icon: CloudSun,
    group: "weather",
    profile: true,
  },
  {
    id: "saved",
    href: "/locations",
    label: "Saved locations",
    description: "The places you follow",
    icon: MapPin,
    group: "weather",
    profile: true,
  },
  {
    id: "explore",
    href: "/explore",
    label: "Explore",
    description: "Browse places by category and country",
    icon: Compass,
    group: "weather",
    profile: true,
  },
  {
    id: "history",
    href: "/history",
    label: "History",
    footerLabel: "Historical data",
    description: "Recorded weather and trends",
    icon: Clock,
    group: "weather",
    profile: true,
  },
  {
    id: "aviation",
    href: "/aviation",
    label: "Aviation",
    description: "METAR, TAF and pre-flight briefings",
    icon: Plane,
    group: "weather",
    profile: true,
  },
  {
    id: "shamwari",
    href: "/shamwari",
    label: "Shamwari",
    footerLabel: "Shamwari AI",
    description: "Ask Shamwari about the weather",
    icon: Compass,
    group: "weather",
    profile: false,
  },
  {
    id: "embed",
    href: "/embed",
    label: "Embed widget",
    description: "Add a weather widget to your site",
    icon: Code2,
    group: "developers",
    profile: false,
  },
  {
    id: "api-keys",
    href: "/developers/keys",
    label: "API keys",
    description: "Create and revoke developer keys",
    icon: KeyRound,
    group: "developers",
    profile: true,
  },
  {
    id: "developers",
    href: "/developers",
    label: "API documentation",
    footerLabel: "Developers & API",
    description: "Build with mukoko weather data",
    icon: Code2,
    group: "developers",
    profile: true,
  },
  {
    id: "help",
    href: "/help",
    label: "Help Center",
    footerLabel: "Help",
    description: "Answers to common questions",
    icon: HelpCircle,
    group: "about",
    profile: true,
  },
  {
    id: "releases",
    href: "/releases",
    label: "Release notes",
    description: "What's new in each release",
    icon: Megaphone,
    group: "about",
    profile: true,
  },
  {
    id: "status",
    href: "/status",
    label: "System status",
    description: "Live health of every data source",
    icon: Activity,
    group: "about",
    profile: true,
  },
  {
    id: "about",
    href: "/about",
    label: "About mukoko weather",
    footerLabel: "About",
    description: "Who builds this and why",
    icon: Info,
    group: "about",
    profile: true,
  },
  {
    id: "terms",
    href: "/terms",
    label: "Terms of Service",
    footerLabel: "Terms",
    description: "The rules for using the app",
    icon: FileText,
    group: "about",
    profile: true,
  },
  {
    id: "privacy",
    href: "/privacy",
    label: "Privacy Policy",
    footerLabel: "Privacy",
    description: "What we collect and why",
    icon: Shield,
    group: "about",
    profile: true,
  },
];

const BY_ID = new Map(NAV_DESTINATIONS.map((d) => [d.id, d]));

/** The destination for an id. Throws on an unknown id (a typo is a build error). */
export function navDestination(id: NavDestinationId): NavDestination {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`Unknown nav destination: ${id}`);
  return d;
}

/** The destinations listed on the profile navigation page, in group order. */
export const PROFILE_DESTINATIONS: NavDestination[] = NAV_DESTINATIONS.filter(
  (d) => d.profile,
);
