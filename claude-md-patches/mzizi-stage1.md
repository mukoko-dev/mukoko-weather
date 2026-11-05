# Suggested CLAUDE.md wording for Mzizi adoption stage 1 (#479)

The coordinator applies these; the stage 1 PR does not edit CLAUDE.md.

## 1. Styling / Brand System, the tokens paragraph (line ~1100)

After "...generated upstream in `@nyuchi/mzizi-skills` (`skills/mzizi-design/tokens-update.css`)." add:

> The generated block is `@nyuchi/mzizi-skills` 0.18.0 (re-vendored 2026-11-05; the only change from 0.11.0 was the added `--radius-xs: 4px`, so the radius scale is now 4/7/12/14/17px and the pill, registered in `globals.css`'s `@theme` as well, so `rounded-xs` is 4px; `mzizi-surfaces.test.ts` still refuses every size word, `rounded-xs` included, in favour of a `--radius-*` role token). Never vendor the registry's 1,670-line `mzizi-tokens-globals.css` wholesale: it redefines surfaces, text, primary and the heading scale; adopt single blocks against the app's own token layer.

## 2. Header & My Weather Modal, the Phone menu paragraph (line ~1399)

Replace "registry commit `780457ae94afd5229a78a5d7ba5146bda8260812`; the eleven local deviations are numbered in the file header" with:

> first vendored at registry commit `780457ae94afd5229a78a5d7ba5146bda8260812` and re-checked against registry tag v4.26.5 (commit `bcd07b08f21b311fc1e7acacad65b40fa0615709`) on 2026-11-05, when the only upstream change was the sign-out row's `px-2` to `px-3.5` (4.26.1); the twelve local deviations are numbered in the file header, the twelfth being that every row and the identity block take their inline inset from `--inset-floor` (14px) and the 4px `p-1` around the rows is a documented `mzizi-spacing-exempt` gutter

And add at the end of that paragraph:

> The rows (`ACCOUNT_MENU_ROW_CLASS`), the group headings and the Notifications note use `px-[var(--inset-floor)]`, are 49px tall (`--touch-target-min`) and the email line and default initials are at the 14px body-sm size; `bundu-floor.test.ts` keeps that and the "nothing under the spacing floor without a written reason" scan of the menu, the bottom bar and the map.

## 3. Mobile bottom nav paragraph and the `.lark` row of the Fauna table

- The pinned items' icon-to-label gap is `--gap-floor` (7px, upstream `gap-1` was 4px), so a pinned item is about 56px tall at 360px and wider (49px at the compact width where the label is screen-reader-only); the bar stays 72px. A `.lark` chip's glyph-to-label gap is `--gap-floor` too (was `gap-1.5`), and the glyph-only My Location chip no longer sets `px-0` (its 49px width is `min-w` alone; `.lark` keeps the 14px inline inset).
- `.lark` row: change `px-3` + "16px label" to `px-[var(--inset-floor)]` + the `--text-nav-label` (14px) label, gap `--gap-floor`.

## 4. A new convention (Styling → Rules, or Accessibility)

> **Spacing floor, `mzizi check`.** `npx @nyuchi/mzizi-cli@0.8.0 check src` (the Mzizi CLI, spacing only: padding under the 14px inset, zero padding, gaps under 7px, negative margins, leading under 1.5) is the measure of the spacing floor (it does not read `var()` or `calc()`). Write floor values as `px-[var(--inset-floor)]`, `gap-[var(--gap-floor)]`, `leading-[var(--leading-floor)]`. An intentional value carries `mzizi-spacing-exempt: <reason>` in a comment on the same line or the line above (the reason is required; a bare marker excuses nothing). Stage 1 of #479 took the bottom bar, the map and the phone menu to zero unexplained findings (347 to 315 across the app; the remaining 315 are the later stages of #479); the CI ratchet comes in stage 6.
