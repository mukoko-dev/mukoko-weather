import { icons as lucideIcons } from "lucide-react";
import { ICON_REGISTRY, SunIcon } from "@/lib/weather-icons";

interface IconProps {
  className?: string;
  size?: number;
}

/*
 * Kept out of weather-icons.tsx on purpose: `icons` is the WHOLE lucide
 * library (1,600+ icons, about 130 KB gzipped), and weather-icons.tsx is
 * imported by the shell on every page. Only the activity cards and the My
 * Weather modal need a lookup by name, and both load lazily.
 */

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
export function ActivityIcon({
  activity,
  icon,
  className = "",
  size = 24,
}: { activity: string; icon?: string } & IconProps) {
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
  const LucideFallback =
    lucideIcons[pascalActivity as keyof typeof lucideIcons];
  if (LucideFallback)
    return <LucideFallback className={className} size={size} />;
  // 4. Default
  return <SunIcon className={className} size={size} />;
}
