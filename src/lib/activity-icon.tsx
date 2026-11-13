import { useEffect, useState, type ComponentType } from "react";
import {
  Church,
  CookingPot,
  Flower2,
  Sprout,
  Store,
  Volleyball,
  Wheat,
} from "lucide-react";
import { ICON_REGISTRY, SunIcon } from "@/lib/weather-icons";

interface IconProps {
  className?: string;
  size?: number;
}

type IconComponent = ComponentType<IconProps>;

/*
 * The whole lucide library (`icons`: 1,600+ icons, about 130 KB gzipped) is
 * never imported statically. A static import put it in front of whoever opened
 * the My Weather modal or the activity advice (issue 551). The icons the
 * shipped activities use are imported by name instead (each ships alone), and
 * the library is fetched only for an icon name nothing here knows, which only
 * an activity stored in the database with a new icon can ask for.
 */

/** The lucide icons the shipped activities use that ICON_REGISTRY lacks. */
const KNOWN_LUCIDE: Record<string, IconComponent> = {
  Church,
  CookingPot,
  Flower2,
  Sprout,
  Store,
  Volleyball,
  Wheat,
};

type LucideLibrary = Record<string, IconComponent>;

const has = (table: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

let libraryRequest: Promise<LucideLibrary> | null = null;
let library: LucideLibrary | null = null;

/** The whole lucide library, requested once, on first need. */
function loadLibrary(): Promise<LucideLibrary> {
  libraryRequest ??= import("lucide-react").then((m) => {
    library = m.icons as unknown as LucideLibrary;
    return library;
  });
  return libraryRequest;
}

/**
 * Convert a kebab-case or lowercase icon name to PascalCase for Lucide lookup.
 * E.g. "tree-pine" → "TreePine", "factory" → "Factory", "flower-2" → "Flower2"
 */
export function toPascalCase(str: string): string {
  return str.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

/**
 * Resolution order (scalable — no code changes needed for new icons):
 * 1. Custom ICON_REGISTRY (app-specific SVG icons)
 * 2. Lucide icon library (1600+ icons, resolved by PascalCase name)
 * 3. Activity ID in the custom registry
 * 4. Activity ID as Lucide lookup (kebab-case → PascalCase)
 * 5. Default SunIcon fallback
 *
 * `lookup` answers steps 2 and 4; `onMiss` is told each time it could not.
 * Pure, so a test can check that the shipped activities need no library.
 */
export function resolveActivityIcon(
  activity: string,
  icon: string | undefined,
  lookup: (pascalName: string) => IconComponent | undefined,
  onMiss: () => void = () => {},
): IconComponent {
  if (icon) {
    const custom = ICON_REGISTRY[icon];
    if (custom) return custom;
    const found = lookup(toPascalCase(icon));
    if (found) return found;
    onMiss();
  }
  const direct = ICON_REGISTRY[activity];
  if (direct) return direct;
  const fallback = lookup(toPascalCase(activity));
  if (fallback) return fallback;
  onMiss();
  return SunIcon;
}

/** The icons steps 2 and 4 can answer without the library. */
export function knownLucideIcon(pascalName: string): IconComponent | undefined {
  return has(KNOWN_LUCIDE, pascalName) ? KNOWN_LUCIDE[pascalName] : undefined;
}

/** The whole library once `wanted` is true and it has arrived; else null. */
function useLucideLibrary(wanted: boolean): LucideLibrary | null {
  const [loaded, setLoaded] = useState<LucideLibrary | null>(library);
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    loadLibrary()
      .then((all) => {
        if (live) setLoaded(all);
      })
      .catch(() => {
        // The chunk did not arrive: the icon known now stays.
      });
    return () => {
      live = false;
    };
  }, [wanted, loaded]);
  return wanted ? loaded : null;
}

/**
 * Render an activity icon by identifier or activity ID. Activities stored in
 * the database can reference any Lucide icon name (e.g. "TreePine", "Anchor",
 * "Factory") without requiring code changes: a name the shipped set does not
 * cover shows the best icon known now and the right one once the library
 * arrives.
 */
export function ActivityIcon({
  activity,
  icon,
  className = "",
  size = 24,
}: { activity: string; icon?: string } & IconProps) {
  let missed = false;
  const known = resolveActivityIcon(activity, icon, knownLucideIcon, () => {
    missed = true;
  });
  const all = useLucideLibrary(missed);
  const Icon = all
    ? resolveActivityIcon(activity, icon, (name) =>
        has(all, name) ? all[name] : undefined,
      )
    : known;
  return <Glyph as={Icon} className={className} size={size} />;
}

/** Draws the icon it is given (a prop, so no component is made while rendering). */
function Glyph({
  as: Icon,
  className,
  size,
}: IconProps & { as: IconComponent }) {
  return <Icon className={className} size={size} />;
}
