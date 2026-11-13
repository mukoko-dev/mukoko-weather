import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVITIES } from "./activities";
import { SunIcon } from "./weather-icons";
import {
  knownLucideIcon,
  resolveActivityIcon,
  toPascalCase,
} from "./activity-icon";

const source = readFileSync(resolve(__dirname, "activity-icon.tsx"), "utf-8");

describe("toPascalCase", () => {
  it("turns kebab-case lucide names into export names, digits included", () => {
    expect(toPascalCase("tree-pine")).toBe("TreePine");
    expect(toPascalCase("cooking-pot")).toBe("CookingPot");
    expect(toPascalCase("factory")).toBe("Factory");
    expect(toPascalCase("flower-2")).toBe("Flower2");
  });
});

describe("shipped activity icons", () => {
  it("each resolve to a real icon without fetching the icon library", () => {
    for (const activity of ACTIVITIES) {
      let misses = 0;
      const Icon = resolveActivityIcon(
        activity.id,
        activity.icon,
        knownLucideIcon,
        () => {
          misses++;
        },
      );
      // A new activity with a new lucide icon goes in KNOWN_LUCIDE (import it
      // by name there), not behind the whole library.
      expect(misses, `${activity.id} (${activity.icon})`).toBe(0);
      expect(Icon, `${activity.id} (${activity.icon})`).not.toBe(SunIcon);
    }
  });

  it("an icon name nothing here knows is reported, and shows the default until the library arrives", () => {
    let misses = 0;
    const Icon = resolveActivityIcon(
      "made-up-activity",
      "made-up-icon",
      knownLucideIcon,
      () => {
        misses++;
      },
    );
    expect(misses).toBeGreaterThan(0);
    expect(Icon).toBe(SunIcon);
  });
});

describe("the icon library stays off the first load", () => {
  it("is imported dynamically, never as a static `icons` import", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bicons\b[^}]*\}\s*from\s*"lucide-react"/,
    );
    expect(source).toContain('import("lucide-react")');
  });
});
