import { useId } from "react";
import { RAIN_TILE_H, RAIN_TILE_W, rainDrops } from "@/lib/sky-rain";

interface Props {
  /** A thunderstorm: adds a faint, rare flash. */
  storm: boolean;
}

/**
 * Rain that moves with CSS only, for the places the Three.js scene is not used
 * (iPhone and iPad, see `backdropMode`): a tile of drops repeated by an SVG
 * pattern, the whole layer sliding down one tile height per loop. It costs one
 * composited element and no script, and it only exists where motion is allowed:
 * the animation is inside `prefers-reduced-motion: no-preference` in
 * globals.css, and `WeatherBackdrop` does not render this under reduced motion,
 * Save-Data or a low-memory report.
 *
 * A thunderstorm adds `.kestrel-flash`: a rare, low-contrast double flicker, at
 * most two flashes in a second (WCAG 2.3.1) and a few seconds apart.
 *
 * Decorative: `aria-hidden`, no pointer events (its parent, `WeatherSky`, is
 * `aria-hidden` and `pointer-events-none` already). Colours come from the sky
 * foreground token in CSS (`--sky-fg`), never from a literal.
 */
export function SkyRain({ storm }: Props) {
  // useId() is ":r0:"; a url(#...) reference wants a plain name.
  const patternId = `kestrel-drops-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <>
      <div className="kestrel-drops">
        <svg aria-hidden="true" focusable="false">
          <defs>
            <pattern
              id={patternId}
              width={RAIN_TILE_W}
              height={RAIN_TILE_H}
              patternUnits="userSpaceOnUse"
            >
              {rainDrops().map((d, i) => (
                <line
                  key={i}
                  x1={d.x1}
                  y1={d.y1}
                  x2={d.x2}
                  y2={d.y2}
                  strokeOpacity={d.opacity}
                />
              ))}
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${patternId})`} />
        </svg>
      </div>
      {storm && <div className="kestrel-flash" />}
    </>
  );
}
