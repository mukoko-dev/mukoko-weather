# Suggested CLAUDE.md wording for Mzizi adoption stage 3 (#479): the 17px body

The coordinator applies these; the stage 3 PR does not edit CLAUDE.md.

## 1. Styling / Brand System, the hero type scale paragraph (the "Mzizi type scale only" rule)

In the list of `--text-*` sizes change "h6 16/1.4" to "h6 17/1.4" and "body 16/1.6" to "body 17/1.6", and add after it:

> (since stage 3 of #479, Mzizi registry 4.23.0: the body size is 17px and H6, the body size in a heading weight, is 17px too; the body leading stays the registry's 1.6, over the 1.5 `--leading-floor`)

## 2. Typography tokens list

Replace the `--text-body: 1rem` line with:

> - `--text-body: 1.0625rem` (17px) / `--text-body-leading: 1.6`: the Bundu floor for body text (registry `--fs-body` / `--lh-body`). It is the size of `<body>` (so of every paragraph, list item, label, button and input that names no size: preflight gives controls `font: inherit`), of the footer, and of Tailwind's `text-base`: in the `@theme inline` block `--text-base` is `var(--text-body)` and `--text-base--line-height` is `var(--text-body-leading)` (the way the registry's `mzizi-tokens-globals.css` raises Tailwind's 16px `text-base`). `--text-h6` is 17px as well. `--text-nav-label`, `--text-caption`, `--text-body-sm` and `text-sm`/`text-xs` stay 14px: the bar's labels and captions are not body text. `--text-body-lg` stays 18px.

## 3. Styling → Rules, after the stage 2 "Text floor" convention

> **Body floor (stage 3 of #479).** Body text is 17px: write `text-base` (or nothing, and inherit from `<body>`), never a literal size. `bundu-floor.test.ts` holds the tokens (`--text-body` and `--text-h6` at or above 17px, the body leading at or above `--leading-floor`), the `@theme` mapping of `text-base`, the `<body>` and `<footer>` rules, and scans every source for a literal size strictly between the 14px caption floor and the 17px body floor (a size is one or the other: `text-[15px]`, `font-size: 16px`, `0.95rem` all fail unless `mzizi-text-exempt: <reason>` is on the line or the line above). `text-sm` (14px) stays for secondary text, captions and labels.
>
> **Check the layout, not the number.** 17px wraps more than 16px, and the body-sized text sits in pills, rows and columns that were sized for 16px. Every place found in a real browser at 340, 375, 393 and 1280px was fixed by letting the box give, never by shrinking the text: a title row that can wrap (`flex-wrap` on `SectionHeader` and the card title rows, so a note or link beside a title drops below it instead of squeezing the title onto three lines), a grid that auto-fits (`grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))]`), a fixed width that becomes a minimum (`min-w-10`), an icon stacked over its label at narrow widths (`max-[390px]:flex-col` on the report type buttons), and `.termite` inline code breaking anywhere (`[overflow-wrap:anywhere]`). The page body clips sideways overflow (`overflow-x: clip`), so a 0 document overflow measure does NOT mean nothing is cut off: compare `scrollWidth` with `clientWidth` on each element (what `overflow.mjs` did).

## 4. Embed widget

> The embed widget's `.todayCondition` label is 17px (it was 15px: the body size), the rest of its small text stays at the 14px floor.

## 5. Where the floor stops (for the next stages)

> Chips, badges and pills that were `text-base` (`Badge`, `StatusBadge`, `CountPill`, `TagPill`, the severity and tag pills in cards) are body-sized now; the registry's own Badge is the 14px caption size, so a later pass can decide to take them to `text-sm`. Stage 3 kept every size growing or equal (nothing got smaller) and did not make that call. The 49px hit region, the 14px inset and the 7px gaps on those pills and rows are the spacing sweep (stage 5), not this stage.
