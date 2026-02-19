/* SVG weather icons as React components */

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

/** Map activity IDs to icon components */
export function ActivityIcon({ activity, className = "", size = 24 }: { activity: string } & IconProps) {
  switch (activity) {
    case "crop-farming": return <CropIcon className={className} size={size} />;
    case "livestock": return <LivestockIcon className={className} size={size} />;
    case "gardening": return <ShovelIcon className={className} size={size} />;
    case "mining": return <PickaxeIcon className={className} size={size} />;
    case "construction": return <HardHatIcon className={className} size={size} />;
    case "driving": return <CarIcon className={className} size={size} />;
    case "commuting": return <BusIcon className={className} size={size} />;
    case "safari": return <BinocularsIcon className={className} size={size} />;
    case "photography": return <CameraIcon className={className} size={size} />;
    case "birdwatching": return <BirdIcon className={className} size={size} />;
    case "running": return <RunningIcon className={className} size={size} />;
    case "cycling": return <BicycleIcon className={className} size={size} />;
    case "hiking": return <MountainIcon className={className} size={size} />;
    case "football": return <FootballIcon className={className} size={size} />;
    case "swimming": return <SwimmingIcon className={className} size={size} />;
    case "golf": return <GolfIcon className={className} size={size} />;
    case "cricket": return <CricketIcon className={className} size={size} />;
    case "walking": return <FootprintsIcon className={className} size={size} />;
    case "barbecue": return <GrillIcon className={className} size={size} />;
    case "outdoor-events": return <TentIcon className={className} size={size} />;
    default: return <SunIcon className={className} size={size} />;
  }
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
