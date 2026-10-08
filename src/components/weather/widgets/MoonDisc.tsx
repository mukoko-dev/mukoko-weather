import * as React from "react";
import { illuminationFromPhase, moonTerminatorPath } from "./geometry";

export interface MoonDiscProps {
  /** Lunar phase 0–1: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number;
  /** Fraction of the disc lit, 0–1. Used for the accessible description. */
  illumination: number;
  /** Mirror the lit side for the southern hemisphere (waxing lit on the left). */
  southernHemisphere?: boolean;
}

const R = 40;

/** Moon disc: shadowed base, lit portion drawn from the terminator path. */
export function MoonDisc({
  phase,
  illumination,
  southernHemisphere = false,
}: MoonDiscProps) {
  const p = ((phase % 1) + 1) % 1;
  const waxing = p < 0.5;
  const pct = Math.round(Math.max(0, Math.min(1, illumination)) * 100);
  const lit = pct > 0 ? moonTerminatorPath(p, R) : "";
  const label = `Moon, ${pct}% illuminated, ${waxing ? "waxing" : "waning"}`;

  return (
    <svg
      viewBox="-44 -44 88 88"
      className="h-auto w-full max-w-[var(--size-insight-moon-max)]"
      role="img"
      aria-label={label}
    >
      <circle r={R} className="fill-moon-shadow" />
      {lit && (
        <path
          d={lit}
          className="fill-moon-lit"
          transform={southernHemisphere ? "scale(-1 1)" : undefined}
          data-illumination={illuminationFromPhase(p)}
        />
      )}
    </svg>
  );
}
