# Suggested CLAUDE.md wording for Mzizi adoption stage 2 (#479): the small-text floor

The coordinator applies these; the stage 2 PR does not edit CLAUDE.md.

## 1. Styling / Brand System, the hero type scale paragraph (the "Mzizi type scale only" rule, ~line 1129)

Replace "caption 12/1.5" in the list of `--text-*` sizes with:

> caption 14/1.5 (since stage 2 of #479, Mzizi registry 4.23.0: the caption and the small size are both 14px)

and in the "Typography tokens" list add:

> - `--text-caption: 0.875rem` (14px) / `--text-caption-leading: 1.5`: the Bundu floor for captions, labels, metadata and secondary text. Nothing a person reads is set under it. In the `@theme inline` block `--text-xs` is `var(--text-caption)` and `--text-sm` is 0.875rem, both at 1.5 leading (the way the registry's `mzizi-tokens-globals.css` raises Tailwind's 12px `text-xs`), so a size class pasted from a vendored component can never land under the floor. The app's own markup says `text-sm` (or the caption token), not `text-xs`.

## 2. Styling → Rules (new convention), after the stage 1 "Spacing floor" convention

> **Text floor (stage 2 of #479).** No font size under 14px: not `text-[11px]`, not `font-size: 12px`, not a Chart.js `font: { size: 11 }`, not a `--text-*` token. `bundu-floor.test.ts` scans every `.ts`, `.tsx` and `.css` file under `src` (not tests) for a literal Tailwind size, a size token under the floor, a CSS `font-size` or `font:` shorthand, an inline `fontSize`, a canvas size, a map `text-size` and any SVG `<text>`, and fails on the first without a written reason. An intentional size carries `mzizi-text-exempt: <reason>` on the line or the comment line above (a bare marker excuses nothing), or `mzizi-text-exempt-file: <reason>` for a file that is not interface text. Exactly two files carry the file-level marker and the test pins that: the OG image route (a 1200x630 picture scaled by the platform) and the aviation briefing PDF (points on paper).
>
> **SVG text is not allowed.** SVG text is sized in the viewBox's units and scales with the element, so a 13px label drew at about 9px in a phone-width tile; the floor is 14px as drawn. Put labels, values and units in HTML beside or over the graphic (`CompassDial` overlays the four cardinal letters at fixed percentages of its square, `PressureDial` and `SunArc` print their scale ends and times in a row under the arc; each is `aria-hidden` because the SVG's `aria-label` already says them).
>
> **Canvas text:** `CHART_FONT_PX` (14) in `components/ui/chart.tsx` is set on `ChartJS.defaults.font.size` and every axis uses it; a canvas cannot read CSS, so the number lives there and the guard keeps it at or above the caption token. MapLibre's own stylesheet sets `font: 12px/20px` on every map (its attribution control inherits it), so `globals.css` ends with an unlayered `.maplibregl-map .maplibregl-ctrl-attrib` rule that takes the caption token.

## 3. Embed widget (Tech Stack / Styling, the "embed widget uses a CSS module" rule)

> The embed widget's CSS module follows the same 14px floor (its 11, 12 and 13px declarations are 14px); a third-party page that embeds it gets the readable size.

## 4. Where the floor stops (for the next stage)

> The 17px body (`--text-body`, `text-base`, 259 uses) is stage 3. `leading-snug`/`leading-tight` on small text (for example `InsightCard`'s sentence) is under the 1.5 body leading but is `mzizi check`'s spacing rule and belongs to the spacing sweep (stage 5), not this floor.
