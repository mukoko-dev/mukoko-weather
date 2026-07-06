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
}

/**
 * Single source of truth for community weather report types — id, display
 * label, and SVG icon. Consumed by both WeatherReportModal (the submission
 * wizard) and RecentReports (the report feed), so the two surfaces of this
 * feature can't silently drift from each other again (previously each kept
 * its own id->label->icon map, hand-synced on every change). Must stay in
 * sync with the backend allowlist in api/py/_reports.py — REPORT_TYPES there
 * is the validation source of truth; this is the display source of truth.
 */
export const REPORT_TYPES: ReportTypeInfo[] = [
  { id: "light-rain", label: "Light Rain", icon: CloudDrizzleIcon },
  { id: "heavy-rain", label: "Heavy Rain", icon: CloudRainIcon },
  { id: "thunderstorm", label: "Thunderstorm", icon: CloudLightningIcon },
  { id: "hail", label: "Hail", icon: CloudHailIcon },
  { id: "flooding", label: "Flooding", icon: WaterIcon },
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
