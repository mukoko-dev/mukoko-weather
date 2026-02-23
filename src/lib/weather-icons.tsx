/* SVG weather icons as React components */
import type React from "react";
import { icons as lucideIcons } from "lucide-react";

interface IconProps {
  className?: string;
  size?: number;
}

export function SunIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function CloudIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

export function CloudSunIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="M20 12h2" />
      <path d="m19.07 4.93-1.41 1.41" /><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128" />
      <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
    </svg>
  );
}

export function CloudRainIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M16 14v6" /><path d="M8 14v6" /><path d="M12 16v6" />
    </svg>
  );
}

export function CloudDrizzleIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M8 19v1" /><path d="M8 14v1" />
      <path d="M16 19v1" /><path d="M16 14v1" />
      <path d="M12 21v1" /><path d="M12 16v1" />
    </svg>
  );
}

export function CloudLightningIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973" />
      <path d="m13 12-3 5h4l-3 5" />
    </svg>
  );
}

export function CloudFogIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M16 17H7" /><path d="M17 21H9" />
    </svg>
  );
}

export function CloudSunRainIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="M20 12h2" />
      <path d="m19.07 4.93-1.41 1.41" /><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128" />
      <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
      <path d="M8 19v2" /><path d="M11 20v2" />
    </svg>
  );
}

export function CloudHailIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M16 14v2" /><path d="M8 14v2" /><path d="M16 20h.01" /><path d="M8 20h.01" />
      <path d="M12 16v2" /><path d="M12 22h.01" />
    </svg>
  );
}

export function SnowflakeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" x2="22" y1="12" y2="12" />
      <line x1="12" x2="12" y1="2" y2="22" />
      <path d="m20 16-4-4 4-4" /><path d="m4 8 4 4-4 4" />
      <path d="m16 4-4 4-4-4" /><path d="m8 20 4-4 4 4" />
    </svg>
  );
}

export function WindIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
      <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
      <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
    </svg>
  );
}

export function DropletIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
    </svg>
  );
}

export function ThermometerIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />
    </svg>
  );
}

export function SunriseIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v8" /><path d="m4.93 10.93 1.41 1.41" /><path d="M2 18h2" />
      <path d="M20 18h2" /><path d="m19.07 10.93-1.41 1.41" />
      <path d="M22 22H2" /><path d="M8 6l4-4 4 4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
    </svg>
  );
}

export function SunsetIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10V2" /><path d="m4.93 10.93 1.41 1.41" /><path d="M2 18h2" />
      <path d="M20 18h2" /><path d="m19.07 10.93-1.41 1.41" />
      <path d="M22 22H2" /><path d="m8 2 4 4 4-4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
    </svg>
  );
}

export function EyeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function GaugeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

export function ClockIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function SearchIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function MapPinIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function ShareIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" x2="12" y1="2" y2="15" />
    </svg>
  );
}

export function SparklesIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" /><path d="M22 5h-4" />
      <path d="M4 17v2" /><path d="M5 18H3" />
    </svg>
  );
}

// ── Activity Icons ──────────────────────────────────────────────────────────

export function CropIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V10" /><path d="M12 10C12 6 8 4 8 4s0 4 4 6" /><path d="M12 10c0-4 4-6 4-6s0 4-4 6" />
      <path d="M12 16c-2 0-4-1.5-4-1.5S10 12 12 14" /><path d="M12 16c2 0 4-1.5 4-1.5S14 12 12 14" />
    </svg>
  );
}

export function LivestockIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" />
      <path d="M5 11V9a2 2 0 0 1 2-2" /><path d="M19 11V9a2 2 0 0 0-2-2" />
      <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
    </svg>
  );
}

export function ShovelIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m14 10-2 2" /><path d="m4 20 6.5-6.5" />
      <path d="M15.5 4.5a2.12 2.12 0 0 1 3 3L13 13l-3-1 1-3z" />
    </svg>
  );
}

export function PickaxeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 10l7-7" /><path d="M21 3l-3.5.5L14 10" />
      <path d="m4 20 8.5-8.5" /><path d="M8 16l-2 2" />
    </svg>
  );
}

export function HardHatIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17h16" /><path d="M6 17v-2a6 6 0 0 1 12 0v2" />
      <path d="M12 3v6" /><path d="M4 17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2" />
    </svg>
  );
}

export function CarIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L17 10l-2-4H9L7 10l-3.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" />
    </svg>
  );
}

export function BusIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6v6" /><path d="M16 6v6" /><rect x="4" y="3" width="16" height="14" rx="2" />
      <path d="M4 11h16" /><circle cx="8" cy="19" r="1" /><circle cx="16" cy="19" r="1" />
      <path d="M4 17h16" />
    </svg>
  );
}

export function BinocularsIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="17" r="3" /><circle cx="17" cy="17" r="3" />
      <path d="M7 14V6a2 2 0 0 1 2-2h0" /><path d="M17 14V6a2 2 0 0 0-2-2h0" />
      <path d="M9 4h6" /><path d="M10 17h4" />
    </svg>
  );
}

export function BirdIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 7h.01" /><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" />
      <path d="m20 7 2 .5-2 .5" /><path d="M10 18v3" /><path d="M14 17.75V21" />
    </svg>
  );
}

export function RunningIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="15" cy="4" r="2" /><path d="m8 20 2-5" /><path d="M10 15l3-3 2 2 3-4" />
      <path d="m6 20 3-7 2.5 1" /><path d="M14 14l2.5 3.5" />
    </svg>
  );
}

export function BicycleIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" />
      <circle cx="15" cy="5" r="1" /><path d="M12 17.5 8.5 8h5L16 12" />
      <path d="M18.5 17.5 16 12h-3.5" />
    </svg>
  );
}

export function MountainIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 3 4 8 5-5 2 15H2z" /><path d="m4.14 15.08 2.86-2.58 3 2.5" />
    </svg>
  );
}

export function FootballIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2l3 7h-6z" /><path d="m7.5 9-5 4" /><path d="m16.5 9 5 4" />
      <path d="M5.5 19l3.5-3" /><path d="M18.5 19l-3.5-3" /><path d="M9 16h6" />
    </svg>
  );
}

export function SwimmingIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="16" cy="4" r="2" /><path d="m10 8 4-2 3 4" />
      <path d="M2 16c1 1 2.5 1.5 4 1s2.5-1.5 4-2 2.5-.5 4 .5 2.5 1.5 4 2 3 0 4-1" />
      <path d="M2 20c1 1 2.5 1.5 4 1s2.5-1.5 4-2 2.5-.5 4 .5 2.5 1.5 4 2 3 0 4-1" />
    </svg>
  );
}

export function GolfIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 18V3l7 4-7 4" /><path d="M8 21a4 4 0 0 1 8 0" /><circle cx="12" cy="21" r="1" />
    </svg>
  );
}

export function CricketIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18 18 6" /><path d="m4 20 2-2" />
      <rect x="14" y="2" width="6" height="6" rx="1" transform="rotate(45 17 5)" />
      <circle cx="7" cy="15" r="2" />
    </svg>
  );
}

export function FootprintsIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5 10 7.27 9 9 8 10h3a8 8 0 0 1 0 6H4z" />
      <path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 1.77 1 3.5 2 4.5h-3a8 8 0 0 0 0 6h7z" />
    </svg>
  );
}

export function GrillIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h16" /><path d="M6 12a6 6 0 0 0 12 0" />
      <path d="M8 20l2-4" /><path d="M16 20l-2-4" /><path d="M12 16v4" />
      <path d="M8 8V6" /><path d="M12 7V5" /><path d="M16 8V6" />
    </svg>
  );
}

export function TentIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 21 12 3l8.5 18" /><path d="M12 3v18" /><path d="M3.5 21h17" />
    </svg>
  );
}

export function CameraIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

// ── Additional Activity Icons ──────────────────────────────────────────────

export function DroneIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h3" /><path d="M18 6h3" /><path d="M3 18h3" /><path d="M18 18h3" />
      <circle cx="4.5" cy="6" r="1.5" /><circle cx="19.5" cy="6" r="1.5" />
      <circle cx="4.5" cy="18" r="1.5" /><circle cx="19.5" cy="18" r="1.5" />
      <path d="M6 7.5L9 10" /><path d="M18 7.5L15 10" />
      <path d="M6 16.5L9 14" /><path d="M18 16.5L15 14" />
      <rect x="9" y="10" width="6" height="4" rx="1" />
    </svg>
  );
}

export function TennisIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M18.09 5.91C14.5 2.32 6 5 6 12s8.5 9.68 12.09 6.09" />
      <path d="M5.91 18.09C9.5 21.68 18 19 18 12S9.5 2.32 5.91 5.91" />
    </svg>
  );
}

export function RugbyIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-45 12 12)" />
      <path d="M5 5l14 14" /><path d="M9 9l6 6" />
    </svg>
  );
}

export function HorseIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 3c-1 0-2 .5-2 2v3l-4 3-4-3V5c0-1.5-1-2-2-2" />
      <path d="M6 5v4l3 3v4l-2 4" /><path d="M18 5v4l-3 3v4l2 4" />
      <path d="M9 12h6" />
    </svg>
  );
}

export function PlaneIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  );
}

export function WaterIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
      <path d="M7.5 17.5c1.5 1.5 4.5 1.5 6 0" />
    </svg>
  );
}

export function FishIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 12c2-5.5 7-7.5 11.5-5.5 0 0 1.5 2 1.5 5.5s-1.5 5.5-1.5 5.5c-4.5 2-9.5 0-11.5-5.5" />
      <path d="M3.5 9S2 12 3.5 15" /><circle cx="14" cy="12" r="1" />
    </svg>
  );
}

export function StarIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function PicnicIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h18" /><path d="M5 12l-2 8h18l-2-8" />
      <path d="M12 4v8" /><path d="M8 4c0 2 1.5 4 4 4s4-2 4-4" />
    </svg>
  );
}

// --- Additional activity icons (expanded categories) ---

export function TreeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-7" /><path d="M7 15l5-11 5 11H7z" />
    </svg>
  );
}

export function BeeIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="10" r="4" /><path d="M12 14v4" /><path d="M9 7l-2-3" /><path d="M15 7l2-3" />
      <path d="M8 10h8" /><path d="M8 12h8" />
    </svg>
  );
}

export function LeafIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
    </svg>
  );
}

export function AnchorIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" /><line x1="12" y1="22" x2="12" y2="8" />
      <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
    </svg>
  );
}

export function FactoryIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    </svg>
  );
}

export function BoltIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function TruckIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 13.52 9H14" />
      <circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" />
    </svg>
  );
}

export function ShipIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />
      <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76" />
      <path d="M12 2v10" />
    </svg>
  );
}

export function ShieldIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

export function PawPrintIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="4" cy="8" r="2" />
      <path d="M16 16s-3-2-4-2-4 2-4 2-2 3 0 4 4 0 4 0 2 1 4 0 0-4 0-4z" />
    </svg>
  );
}

export function TrophyIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

export function WhistleIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="16" cy="14" r="6" /><path d="M2 8l8 4" /><path d="M10 12l3 1" />
      <line x1="2" y1="6" x2="6" y2="8" />
    </svg>
  );
}

export function CalendarIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4" /><path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function MusicIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function HeartPulseIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </svg>
  );
}

export function GraduationCapIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" /><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </svg>
  );
}

export function BoxIcon({ className = "", size = 24 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
    </svg>
  );
}

/**
 * Icon registry — maps icon identifiers (stored in MongoDB) to SVG components.
 * New activities can reference any icon in this registry via their `icon` field.
 */
export const ICON_REGISTRY: Record<string, (props: IconProps) => React.JSX.Element> = {
  // Agriculture & Forestry
  crop: CropIcon,
  livestock: LivestockIcon,
  shovel: ShovelIcon,
  water: WaterIcon,
  tree: TreeIcon,
  bee: BeeIcon,
  leaf: LeafIcon,
  // Industry & Construction
  pickaxe: PickaxeIcon,
  hardhat: HardHatIcon,
  factory: FactoryIcon,
  bolt: BoltIcon,
  box: BoxIcon,
  // Transport & Logistics
  car: CarIcon,
  bus: BusIcon,
  plane: PlaneIcon,
  truck: TruckIcon,
  ship: ShipIcon,
  // Outdoors & Conservation
  binoculars: BinocularsIcon,
  camera: CameraIcon,
  bird: BirdIcon,
  tent: TentIcon,
  star: StarIcon,
  fish: FishIcon,
  anchor: AnchorIcon,
  shield: ShieldIcon,
  pawprint: PawPrintIcon,
  mountain: MountainIcon,
  // Sports & Fitness
  running: RunningIcon,
  bicycle: BicycleIcon,
  football: FootballIcon,
  swimming: SwimmingIcon,
  golf: GolfIcon,
  cricket: CricketIcon,
  tennis: TennisIcon,
  rugby: RugbyIcon,
  horse: HorseIcon,
  trophy: TrophyIcon,
  whistle: WhistleIcon,
  // Lifestyle & Events
  footprints: FootprintsIcon,
  grill: GrillIcon,
  drone: DroneIcon,
  picnic: PicnicIcon,
  sparkles: SparklesIcon,
  calendar: CalendarIcon,
  music: MusicIcon,
  heartpulse: HeartPulseIcon,
  graduationcap: GraduationCapIcon,
  sun: SunIcon,
};

/**
 * Convert a kebab-case or lowercase icon name to PascalCase for Lucide lookup.
 * E.g. "tree-pine" → "TreePine", "factory" → "Factory"
 */
function toPascalCase(str: string): string {
  return str.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
}

/**
 * Render an activity icon by identifier or activity ID.
 *
 * Resolution order (scalable — no code changes needed for new icons):
 * 1. Custom ICON_REGISTRY (app-specific SVG icons)
 * 2. Lucide icon library (1600+ icons, resolved by PascalCase name)
 * 3. Activity ID as Lucide lookup (kebab-case → PascalCase)
 * 4. Default SunIcon fallback
 *
 * Activities stored in the database can reference any Lucide icon name
 * (e.g. "TreePine", "Anchor", "Factory") without requiring code changes.
 */
export function ActivityIcon({ activity, icon, className = "", size = 24 }: { activity: string; icon?: string } & IconProps) {
  // 1. Try custom icon registry (app-specific SVGs)
  if (icon) {
    const CustomIcon = ICON_REGISTRY[icon];
    if (CustomIcon) return <CustomIcon className={className} size={size} />;
    // 2. Try Lucide icons by PascalCase name
    const pascalName = toPascalCase(icon);
    const LucideIcon = lucideIcons[pascalName as keyof typeof lucideIcons];
    if (LucideIcon) return <LucideIcon className={className} size={size} />;
  }
  // 3. Fallback: try activity ID in custom registry, then Lucide
  const DirectMatch = ICON_REGISTRY[activity];
  if (DirectMatch) return <DirectMatch className={className} size={size} />;
  const pascalActivity = toPascalCase(activity);
  const LucideFallback = lucideIcons[pascalActivity as keyof typeof lucideIcons];
  if (LucideFallback) return <LucideFallback className={className} size={size} />;
  // 4. Default
  return <SunIcon className={className} size={size} />;
}

/** Map weather icon names to components */
export function WeatherIcon({ icon, className = "", size = 24 }: { icon: string } & IconProps) {
  switch (icon) {
    case "sun": return <SunIcon className={className} size={size} />;
    case "cloud": return <CloudIcon className={className} size={size} />;
    case "cloud-sun": return <CloudSunIcon className={className} size={size} />;
    case "cloud-rain": return <CloudRainIcon className={className} size={size} />;
    case "cloud-drizzle": return <CloudDrizzleIcon className={className} size={size} />;
    case "cloud-lightning": return <CloudLightningIcon className={className} size={size} />;
    case "cloud-fog": return <CloudFogIcon className={className} size={size} />;
    case "cloud-sun-rain": return <CloudSunRainIcon className={className} size={size} />;
    case "cloud-hail": return <CloudHailIcon className={className} size={size} />;
    case "snowflake": return <SnowflakeIcon className={className} size={size} />;
    default: return <CloudIcon className={className} size={size} />;
  }
}
