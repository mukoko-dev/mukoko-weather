"use client";

import { useMemo } from "react";
import { useAppStore } from "@/lib/store";
import { ACTIVITIES, type ActivityCategory } from "@/lib/activities";
import type { WeatherInsights } from "@/lib/weather";

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

const MOON_PHASES = [
  "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
  "Full Moon", "Waning Gibbous", "Third Quarter", "Waning Crescent",
] as const;

function moonPhaseName(phase: number): string {
  return MOON_PHASES[phase] ?? "Unknown";
}

function heatStressLevel(index: number): { label: string; className: string } {
  if (index < 22) return { label: "None", className: "text-green-600" };
  if (index < 24) return { label: "Mild", className: "text-yellow-600" };
  if (index < 26) return { label: "Moderate", className: "text-orange-500" };
  if (index < 28) return { label: "Medium", className: "text-orange-600" };
  if (index < 30) return { label: "Severe", className: "text-red-600" };
  return { label: "Extreme", className: "text-red-800" };
}

function precipTypeName(type: number): string {
  switch (type) {
    case 0: return "None";
    case 1: return "Rain";
    case 2: return "Snow";
    case 3: return "Freezing Rain";
    case 4: return "Ice Pellets";
    default: return "Unknown";
  }
}

function uvConcernLabel(concern: number): { label: string; className: string } {
  if (concern <= 2) return { label: "Low", className: "text-green-600" };
  if (concern <= 5) return { label: "Moderate", className: "text-yellow-600" };
  if (concern <= 7) return { label: "High", className: "text-orange-500" };
  if (concern <= 10) return { label: "Very High", className: "text-red-600" };
  return { label: "Extreme", className: "text-red-800" };
}

// ---------------------------------------------------------------------------
// Reusable stat item
// ---------------------------------------------------------------------------

function InsightStat({
  icon,
  label,
  value,
  detail,
  detailClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  detailClassName?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-input)] bg-surface-base p-3">
      <span className="shrink-0 text-text-tertiary" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-text-tertiary">{label}</p>
        <p className="text-sm font-medium text-text-primary">{value}</p>
        {detail && (
          <p className={`text-sm font-semibold ${detailClassName ?? "text-text-secondary"}`}>{detail}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG icons (inline, Lucide-style)
// ---------------------------------------------------------------------------

function SproutIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 20h10" /><path d="M10 20c5.5-2.5 8-8 8-14" />
      <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" />
      <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />
    </svg>
  );
}

function DropletSmallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
    </svg>
  );
}

function ThermometerSmallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />
    </svg>
  );
}

function CloudLightningIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973" />
      <path d="m13 12-3 5h4l-3 5" />
    </svg>
  );
}

function SunIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function EyeSmallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function WindSmallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
      <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
      <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
    </svg>
  );
}

function MoonIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function CloudIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

function CloudRainIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M16 14v6" /><path d="M8 14v6" /><path d="M12 16v6" />
    </svg>
  );
}

function FlameIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function HardHatIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z" />
      <path d="M10 15V7a2 2 0 0 1 4 0v8" /><path d="M5 15V9a7 7 0 0 1 14 0v6" />
    </svg>
  );
}

function CarIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" />
    </svg>
  );
}

function CameraIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function CoffeeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2v2" /><path d="M14 2v2" /><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-1" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------

function FarmingCard({ insights }: { insights: WeatherInsights }) {
  const hasGdd = insights.gdd10To30 != null || insights.gdd08To30 != null || insights.gdd03To25 != null;

  return (
    <InsightCard title="Farming Intelligence" icon={<SproutIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.gdd10To30 != null && (
          <InsightStat icon={<SproutIcon />} label="Maize/Soy GDD" value={`${insights.gdd10To30.toFixed(1)}`} detail="10–30 °C base" />
        )}
        {insights.gdd08To30 != null && (
          <InsightStat icon={<SproutIcon />} label="Sorghum GDD" value={`${insights.gdd08To30.toFixed(1)}`} detail="8–30 °C base" />
        )}
        {insights.gdd03To25 != null && (
          <InsightStat icon={<SproutIcon />} label="Potato GDD" value={`${insights.gdd03To25.toFixed(1)}`} detail="3–25 °C base" />
        )}
        {insights.gdd10To31 != null && (
          <InsightStat icon={<SproutIcon />} label="Sunflower GDD" value={`${insights.gdd10To31.toFixed(1)}`} detail="10–31 °C base" />
        )}
        {insights.evapotranspiration != null && (
          <InsightStat icon={<DropletSmallIcon />} label="Water Loss" value={`${insights.evapotranspiration.toFixed(1)} mm`} detail="Evapotranspiration" />
        )}
        {insights.dewPoint != null && (
          <InsightStat
            icon={<ThermometerSmallIcon />}
            label="Dew Point"
            value={`${Math.round(insights.dewPoint)}°C`}
            detail={insights.dewPoint > 20 ? "Disease risk" : insights.dewPoint < 5 ? "Frost risk" : "Normal"}
            detailClassName={insights.dewPoint > 20 ? "text-orange-500" : insights.dewPoint < 5 ? "text-blue-500" : "text-green-600"}
          />
        )}
        {insights.precipitationType != null && insights.precipitationType > 0 && (
          <InsightStat icon={<CloudRainIcon />} label="Precipitation" value={precipTypeName(insights.precipitationType)} />
        )}
        {!hasGdd && insights.evapotranspiration == null && insights.dewPoint != null && (
          <p className="col-span-full text-sm text-text-tertiary">GDD data not available for this forecast period</p>
        )}
      </div>
    </InsightCard>
  );
}

function MiningCard({ insights }: { insights: WeatherInsights }) {
  return (
    <InsightCard title="Mining & Construction Safety" icon={<HardHatIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.heatStressIndex != null && (
          <InsightStat
            icon={<FlameIcon />}
            label="Heat Stress"
            value={`${insights.heatStressIndex.toFixed(0)}`}
            detail={heatStressLevel(insights.heatStressIndex).label}
            detailClassName={heatStressLevel(insights.heatStressIndex).className}
          />
        )}
        {insights.thunderstormProbability != null && (
          <InsightStat
            icon={<CloudLightningIcon />}
            label="Lightning Risk"
            value={`${Math.round(insights.thunderstormProbability)}%`}
            detail={insights.thunderstormProbability > 50 ? "Suspend outdoor ops" : insights.thunderstormProbability > 20 ? "Monitor closely" : "Low risk"}
            detailClassName={insights.thunderstormProbability > 50 ? "text-red-600" : insights.thunderstormProbability > 20 ? "text-orange-500" : "text-green-600"}
          />
        )}
        {insights.visibility != null && (
          <InsightStat icon={<EyeSmallIcon />} label="Visibility" value={`${insights.visibility.toFixed(1)} km`} />
        )}
      </div>
    </InsightCard>
  );
}

function SportsCard({ insights }: { insights: WeatherInsights }) {
  return (
    <InsightCard title="Sports & Fitness" icon={<FlameIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.heatStressIndex != null && (
          <InsightStat
            icon={<FlameIcon />}
            label="Heat Stress"
            value={`${insights.heatStressIndex.toFixed(0)}`}
            detail={heatStressLevel(insights.heatStressIndex).label}
            detailClassName={heatStressLevel(insights.heatStressIndex).className}
          />
        )}
        {insights.thunderstormProbability != null && (
          <InsightStat
            icon={<CloudLightningIcon />}
            label="Storm Risk"
            value={`${Math.round(insights.thunderstormProbability)}%`}
            detail={insights.thunderstormProbability > 40 ? "Move indoors" : insights.thunderstormProbability > 15 ? "Stay alert" : "Safe"}
            detailClassName={insights.thunderstormProbability > 40 ? "text-red-600" : insights.thunderstormProbability > 15 ? "text-orange-500" : "text-green-600"}
          />
        )}
        {insights.uvHealthConcern != null && (
          <InsightStat
            icon={<SunIcon />}
            label="UV Protection"
            value={`${insights.uvHealthConcern}`}
            detail={uvConcernLabel(insights.uvHealthConcern).label}
            detailClassName={uvConcernLabel(insights.uvHealthConcern).className}
          />
        )}
      </div>
    </InsightCard>
  );
}

function TravelCard({ insights }: { insights: WeatherInsights }) {
  return (
    <InsightCard title="Travel & Driving" icon={<CarIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.visibility != null && (
          <InsightStat
            icon={<EyeSmallIcon />}
            label="Visibility"
            value={`${insights.visibility.toFixed(1)} km`}
            detail={insights.visibility < 1 ? "Very poor" : insights.visibility < 5 ? "Reduced" : "Good"}
            detailClassName={insights.visibility < 1 ? "text-red-600" : insights.visibility < 5 ? "text-orange-500" : "text-green-600"}
          />
        )}
        {insights.thunderstormProbability != null && (
          <InsightStat
            icon={<CloudLightningIcon />}
            label="Storm Risk"
            value={`${Math.round(insights.thunderstormProbability)}%`}
          />
        )}
        {insights.precipitationType != null && insights.precipitationType > 0 && (
          <InsightStat icon={<CloudRainIcon />} label="Road Conditions" value={precipTypeName(insights.precipitationType)} />
        )}
        {insights.visibility != null && insights.precipitationType === 0 && insights.thunderstormProbability == null && (
          <InsightStat icon={<WindSmallIcon />} label="Crosswinds" value="Check wind data" />
        )}
      </div>
    </InsightCard>
  );
}

function TourismCard({ insights }: { insights: WeatherInsights }) {
  return (
    <InsightCard title="Tourism & Photography" icon={<CameraIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.moonPhase != null && (
          <InsightStat icon={<MoonIcon />} label="Moon Phase" value={moonPhaseName(insights.moonPhase)} />
        )}
        {insights.uvHealthConcern != null && (
          <InsightStat
            icon={<SunIcon />}
            label="UV Protection"
            value={`${insights.uvHealthConcern}`}
            detail={uvConcernLabel(insights.uvHealthConcern).label}
            detailClassName={uvConcernLabel(insights.uvHealthConcern).className}
          />
        )}
        {insights.cloudBase != null && (
          <InsightStat icon={<CloudIcon />} label="Cloud Base" value={`${insights.cloudBase.toFixed(1)} km`} />
        )}
        {insights.visibility != null && (
          <InsightStat icon={<EyeSmallIcon />} label="Visibility" value={`${insights.visibility.toFixed(1)} km`} />
        )}
      </div>
    </InsightCard>
  );
}

function CasualCard({ insights }: { insights: WeatherInsights }) {
  return (
    <InsightCard title="Outdoor Comfort" icon={<CoffeeIcon />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {insights.uvHealthConcern != null && (
          <InsightStat
            icon={<SunIcon />}
            label="UV Protection"
            value={`${insights.uvHealthConcern}`}
            detail={uvConcernLabel(insights.uvHealthConcern).label}
            detailClassName={uvConcernLabel(insights.uvHealthConcern).className}
          />
        )}
        {insights.heatStressIndex != null && (
          <InsightStat
            icon={<FlameIcon />}
            label="Comfort"
            value={`${insights.heatStressIndex.toFixed(0)}`}
            detail={heatStressLevel(insights.heatStressIndex).label}
            detailClassName={heatStressLevel(insights.heatStressIndex).className}
          />
        )}
        {insights.thunderstormProbability != null && (
          <InsightStat
            icon={<CloudLightningIcon />}
            label="Storm Risk"
            value={`${Math.round(insights.thunderstormProbability)}%`}
          />
        )}
      </div>
    </InsightCard>
  );
}

// ---------------------------------------------------------------------------
// Card wrapper
// ---------------------------------------------------------------------------

function InsightCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-primary" aria-hidden="true">{icon}</span>
          <h3 className="text-base font-semibold text-text-primary font-heading">{title}</h3>
        </div>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Category → card mapping
// ---------------------------------------------------------------------------

const CATEGORY_CARDS: Record<ActivityCategory, React.FC<{ insights: WeatherInsights }>> = {
  farming: FarmingCard,
  mining: MiningCard,
  sports: SportsCard,
  travel: TravelCard,
  tourism: TourismCard,
  casual: CasualCard,
  // location tags that aren't activity categories — no dedicated card
  city: CasualCard,
  education: CasualCard,
  border: TravelCard,
  "national-park": TourismCard,
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ActivityInsights({ insights }: { insights?: WeatherInsights }) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);

  const activeCategories = useMemo(() => {
    const cats = new Set<ActivityCategory>();
    for (const id of selectedActivities) {
      const activity = ACTIVITIES.find((a) => a.id === id);
      if (activity) cats.add(activity.category);
    }
    return [...cats];
  }, [selectedActivities]);

  if (!insights || activeCategories.length === 0) return null;

  // Deduplicate card components (e.g., city and education both map to CasualCard)
  const seen = new Set<React.FC<{ insights: WeatherInsights }>>();
  const cards: { category: ActivityCategory; Card: React.FC<{ insights: WeatherInsights }> }[] = [];
  for (const cat of activeCategories) {
    const Card = CATEGORY_CARDS[cat];
    if (Card && !seen.has(Card)) {
      seen.add(Card);
      cards.push({ category: cat, Card });
    }
  }

  if (cards.length === 0) return null;

  return (
    <div className="space-y-4">
      {cards.map(({ category, Card }) => (
        <Card key={category} insights={insights} />
      ))}
    </div>
  );
}
