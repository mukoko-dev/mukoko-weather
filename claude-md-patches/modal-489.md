# CLAUDE.md lines for PR #489 (modals and sheets): owner-only, not applied

CLAUDE.md is owner-only (a PR may not touch it), so these are the edits, by section. Nothing here is applied. Issue #482, PR #489.

## Project structure (the tree)

Under `components/ui/`, replace the `dialog.tsx` line with:

```text
│   │   │   ├── dialog.tsx            # Dialog (Radix): the ONE modal and phone bottom sheet. DialogContent owns the pinned top bar (grab pill, the title through its `heading` / `headingClassName` props, optional `actions`, a round Close at the top right: 49px, --float-border hairline, `data-sheet-close`), pull down to dismiss on phones (src/lib/sheet-drag.ts), the --radius-screen corners, the home-indicator inset and `scroll-pt-[var(--sheet-bar-height)]`. A modal never draws its own Close or handle (DialogSheetHandle is gone); dialog.test.ts lists every modal that uses it
```

Replace the `detail-sheet.tsx` line's last clause with: `... Its full-width Close at the foot stays for the thumb and is named "Close sheet", so a dialog has one control called "Close" (the bar's)`.

Under `src/lib/`, add:

```text
│   │   ├── sheet-drag.ts          # Pull down to dismiss for the phone sheet: pure decisions (dismissDistance, decideRelease, readMove, nextVelocity, canScrollUp) + attachSheetDrag(el, {dismiss}). One transform on one element, no React state, no dependency. Bar: pointer events; content: touch events, only while at its top; never from fields, canvas, [data-no-swipe], sideways scrollers. Closes by clicking the bar's [data-sheet-close]
│   │   ├── sheet-drag.test.ts     # The decisions, and the gesture state machine driven through a fake element (jitter, fling, refusal, reduced motion, sm)
│   │   ├── breakpoints.ts         # SM_BREAKPOINT_PX / SM_UP_QUERY: the `sm` breakpoint in one constant for code that must ask what `sm:` classes answer; breakpoints.test.ts holds it to Tailwind's theme
│   │   ├── node-ref.ts            # setRef(ref, node): points a caller's ref at a node and returns its undo (keeps the cleanup a function ref returns, React 19)
```

`src/lib/harness/index.tsx` description: add "exports `REDUCED_QUERY` and `readReducedMotion` (a local change from upstream) so the sheet's pull-down asks the same reduced-motion question".

## Styling / Brand System

Add under the radius/tokens text:

> **Sheet corner and bar.** `--radius-screen` (2.75rem, 44px) is the corner of a phone bottom sheet (its top corners; a full-height sheet stops short of the status bar by `--float-top` so the curve shows). CSS cannot read the device's screen radius, so it is a stand-in inside the range of current phones (about 28 to 55px), and it keeps the 49px Close (7px from the corner) inside the curve. It is a LOCAL token: Mzizi's radius scale (4, 7, 12, 14, 17px, pill) has no sheet or screen radius, so it is proposed upstream to mzizi-dev/mzizi-registry and is not in `mzizi-tokens.css`. `--sheet-bar-height` is the pinned bar (7px + the 49px row + 7px + `--minerals-accent-height`, 66px); the sheet's scroller keeps it as scroll padding at the top.

## Components / conventions

Add a rule under "Component Architecture" (or Accessibility):

> **Modals and sheets.** Every modal goes through the shared `DialogContent` (`src/components/ui/dialog.tsx`): it brings the pinned top bar with a Close at the top right, pull down to dismiss on phones, screen-radius corners and the home-indicator inset, so no modal draws its own Close, handle or radius. Pass the title as `heading` (and `headingClassName`, `actions`); a body `DialogTitle` is only for a title that cannot be a bar title. The pull dismisses by clicking the bar's own `[data-sheet-close]`, so Radix's focus trap, scroll lock and Escape run as for any close. A modal that must open on a particular control passes `onOpenAutoFocus` (the install prompt focuses "Install app"; every other dialog opens on its first control, the bar's Close or `actions`). `scripts/browser-check/modal-sheet.mjs` checks all of it with real touch; run it for any change to a modal.

## Known follow-up (not built)

> The Conditions tile sheets (`MetricDetailModal`) do not return focus to the tile that opened them: Radix only returns focus to a `DialogTrigger`, and the tiles are not one (`ActivitiesDetailSheet` passes `returnFocusTo`; the tile sheets never did). Not new, and not part of #489.

## Testing list

Add: `src/components/ui/dialog.test.ts` (the shared modal: Close in the bar and not switchable off, floor numbers, scroll padding = bar height, the token defined once and local, every modal goes through the shared content, no private Close, the install prompt), `src/lib/sheet-drag.test.ts`, `src/lib/breakpoints.test.ts`, `src/lib/node-ref.test.ts`.
