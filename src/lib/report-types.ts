import { Flame } from "lucide-react";
import {
  CloudDrizzleIcon,
  CloudRainIcon,
  CloudLightningIcon,
  CloudHailIcon,
  WaterIcon,
  WindIcon,
  SunIcon,
  CloudIcon,
  CloudFogIcon,
  SnowflakeIcon,
} from "@/lib/weather-icons";

interface ReportIconProps {
  className?: string;
  size?: number;
}

export interface ReportTypeInfo {
  id: string;
  label: string;
  icon: React.ComponentType<ReportIconProps>;
  /**
   * A forecast can never confirm this type, so a report of it is always shown
   * as "Community report, unverified" and never as verified. Mirrors
   * `NEVER_VERIFIED` in `weather_core::community` (report-types.test.ts
   * compares them).
   */
  neverVerified?: true;
  /**
   * Said plainly in the wizard before the report is sent (a type where a
   * person could be in danger).
   */
  notice?: string;
  /** Said in the wizard once the report is sent: how it is shown, and what it does not do. */
  sentNote?: string;
}

/** What a report no forecast can confirm is called wherever it is shown. */
export const UNVERIFIED_REPORT_LABEL = "Community report, unverified";

/**
 * The wizard's note on a wildfire report: the app is not an emergency service.
 * No phone number, because the app is used in many countries.
 */
export const EMERGENCY_NOTICE =
  "This is not an emergency service. If anyone is in danger, call your local emergency services first.";

/** What the wizard says once a wildfire report is sent. */
export const WILDFIRE_SENT_NOTE = `It is shown to people nearby as: ${UNVERIFIED_REPORT_LABEL}. It does not call anyone for help.`;

/**
 * Single source of truth for community weather report types — id, display
 * label, and SVG icon. Consumed by both WeatherReportModal (the submission
 * wizard) and RecentReports (the report feed), so the two surfaces of this
 * feature can't silently drift from each other again (previously each kept
 * its own id->label->icon map, hand-synced on every change). Must stay in
 * sync with the backend allowlist — REPORT_TYPES in
 * workers/crates/weather-core/src/community.rs is the validation source of
 * truth (report-types.test.ts compares the two, and the bridge's copy in
 * workers/mongo-bridge/src/validate.ts); this is the display source of truth.
 */
export const REPORT_TYPES: ReportTypeInfo[] = [
  { id: "light-rain", label: "Light Rain", icon: CloudDrizzleIcon },
  { id: "heavy-rain", label: "Heavy Rain", icon: CloudRainIcon },
  { id: "thunderstorm", label: "Thunderstorm", icon: CloudLightningIcon },
  { id: "hail", label: "Hail", icon: CloudHailIcon },
  { id: "flooding", label: "Flooding", icon: WaterIcon },
  {
    id: "wildfire",
    label: "Wildfire",
    icon: Flame,
    neverVerified: true,
    notice: EMERGENCY_NOTICE,
    sentNote: WILDFIRE_SENT_NOTE,
  },
  { id: "strong-wind", label: "Strong Wind", icon: WindIcon },
  { id: "clear-skies", label: "Clear Skies", icon: SunIcon },
  { id: "cloudy", label: "Cloudy", icon: CloudIcon },
  { id: "fog", label: "Fog", icon: CloudFogIcon },
  { id: "mist", label: "Mist", icon: CloudFogIcon },
  { id: "haze", label: "Haze", icon: CloudFogIcon },
  { id: "dust", label: "Dust", icon: CloudIcon },
  { id: "frost", label: "Frost", icon: SnowflakeIcon },
];

const REPORT_TYPES_BY_ID: Record<string, ReportTypeInfo> = Object.fromEntries(
  REPORT_TYPES.map((t) => [t.id, t]),
);

/** O(1) lookup by report type id — returns undefined for an unknown id. */
export function getReportTypeInfo(id: string): ReportTypeInfo | undefined {
  return REPORT_TYPES_BY_ID[id];
}

/**
 * Is this report shown with a "Verified" mark? Only when the Worker verified
 * it AND the type is one a forecast can confirm: a type in
 * `neverVerified` is never labelled verified, whatever the stored flag says.
 */
export function showsVerified(id: string, verified: boolean): boolean {
  return verified && REPORT_TYPES_BY_ID[id]?.neverVerified !== true;
}

/** "Community report, unverified" for a type no forecast can confirm, else null. */
export function unverifiedLabel(id: string): string | null {
  return REPORT_TYPES_BY_ID[id]?.neverVerified === true
    ? UNVERIFIED_REPORT_LABEL
    : null;
}
