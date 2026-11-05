# CLAUDE.md patch: the avatar and My Location swapped places (mukoko-dev/mukoko-weather#525)

Owner-only file, so this is a proposal, not an edit. Each block names the CLAUDE.md
passage and gives the replacement. Source of truth for the change: branch
`feat/avatar-in-bar-locate-on-top`.

## Project Structure tree

- `components/layout/Header.tsx`: replace "+ the phone ⋯ menu (PhoneMenu)" with
  "+ My Location (MyLocationLink) in the phone pill".
- `components/layout/PhoneMenu.tsx`: "The ONE phone menu: a thin wrapper that fills the Mzizi
  AccountMenu ... Two homes: the header's action pill (⋯ trigger) and the hero's top row
  (profile trigger)" becomes "... One home: the first slot of the phone bottom bar
  (MobileNav.tsx), opening UPWARD (`panelPlacement="above"`)".
- NEW line after PhoneMenu: `MyLocationLink.tsx  # My Location: the round location-arrow link to / (aria-label "My Location", aria-current on /, a plain click is an in-place switch through handlePlaceLinkClick). ONE component, two homes: the hero's phone icon group (.hadeda) and the header's phone pill`.
- `components/layout/PlaceLane.tsx`: "My Location pinned first, then one `.lark` chip per place"
  becomes "one `.lark` chip per place (My Location is no longer a chip; the account control is
  the slot before the lane)".
- `components/weather/CurrentConditions.tsx`: "top row (breadcrumb slot, round Share, phone-only ⋯ menu)"
  becomes "top row (breadcrumb slot, round Share, phone-only My Location link)".
- `components/ui/app-account-menu.tsx`: "the eleven/twelve local deviations" becomes "thirteen";
  the new one is `panelPlacement="above"` (see below).
- `lib/location-pager.ts` list: drop `homeChipShowsLabel` (removed).
- `scripts/browser-check`: add `account-menu-bar.mjs`.

## Header & My Weather Modal

**Action pill** list item 3 and the bullets after it. Replace the three-item list with:

1. **Layers icon** (`sm` up): Weather map.
2. **My Location** (phones only, `MyLocationLink`, `bee sm:hidden`): the round arrow link to `/`. It took the place of the old ⋯ account menu (owner, 2026-11-05).
3. **Bell icon**: opens the notifications centre.
4. **Account icon** (`sm` up only, `hidden sm:flex`): signed out, the user icon linking to `/auth/signin`; signed in, the avatar linking to `/profile`. On a phone the avatar is the bottom bar's first slot.

## Mobile bottom nav

Replace item 2 ("The places lane ... My Location first ...") with:

2. **The account control, then the places lane** (the `lane` slot of the bar is a wrapper holding two `MziziHarness` boundaries). **The account control** (`PhoneMenu`, boundary `account-menu`, fallback a plain `/profile` link) is the Mzizi account menu's round trigger: a 49px `.plover` circle (`ACCOUNT_SLOT_CLASS` in MobileNav.tsx): the profile photo or the initials when signed in, the user icon otherwise; its menu opens UPWARD from the bar. **The places lane** (`src/components/layout/PlaceLane.tsx`, boundary `place-lane`, fallback a plain My Location link, so a crash drops only the lane): one chip per place in the swipe sequence in a sideways scroller (`.sanderling` ...). With no places the lane draws nothing and its boundary is `empty:hidden`, so the account control sits centred. My Location is NOT a chip any more: it is the round arrow link in the hero's top-right group and in the header's phone pill (`MyLocationLink`), so it is reachable on every phone page. The pager sequence still starts at `/` (a swipe from the first saved place goes to My Location; no chip is current on `/`, and the lane returns to its start).

In "The pinned item that is current ...": "the lane marks its own current chip, My Location on `/` included" becomes "the lane marks its own current chip (a place on its page; on `/` no bar item is current, My Location's own link carries `aria-current`)".

## Phone menu

- Heading line: "(`PhoneMenu`, ...; header icon pill, `sm:hidden`)" becomes "(`PhoneMenu`, ...; the first slot of the phone bottom bar)".
- "the eleven local deviations" becomes "the thirteen local deviations". New deviation 13, `panelPlacement="above"`: the panel opens upward and into the screen. It is `absolute bottom-full left-0` and the `<details>` is `static`, so the panel hangs from the nearest POSITIONED ANCESTOR, which in the bar is the bar's `<nav>` (`fixed`): the panel's left edge is the bar's, its bottom edge is `--float-gap` above the bar's top edge, its width is `min(18rem, 100vw - --float-left - --float-right)` and its max-height is the room above the bar (`100dvh - --float-top - --float-bottom - --mobile-nav-bar-height - --float-gap`). It is NOT `fixed` like the below-the-trigger panel (deviation 11) because the bar has a `backdrop-filter`, which makes it the containing block of any `fixed` descendant. Contract: no positioned element, `overflow` clip, transform or filter between the menu and the bar (`MobileNav.render.test.ts` walks the ancestors).
- Replace the "**Two homes.**" bullet with: "**One home.** The first slot of the phone bottom bar (owner, 2026-11-05: the avatar and My Location swapped places). The hero and the header's phone pill no longer carry the account menu; they carry My Location (`MyLocationLink`). The header's phone pill is My Location + the bell; its account icon is `sm` up only. The menu keeps every row (Account / Sign in, My Weather, Use my location, Weather map, Notifications, the destinations). A Campfire row is NOT added: nothing exists behind it (#525)."
- "Phone header over the sky": "the hero's top row holds breadcrumb + Share + the profile button" becomes "breadcrumb + Share + My Location".

## Open sky (location hero)

`.hadeda` holds Share and My Location (`--hadeda-controls: 2`, unchanged). Delete the sentence about the profile menu's fixed panel being the reason for the pseudo-element blur, or reword it: the blur stays on the pseudo-element so nothing `fixed` inside the group can be captured. The `[data-sky-hero] [data-slot="account-menu-panel"]` focus-ring override is gone (the panel is not in the hero any more); `[data-sky-hero] .hadeda` keeps its page ring.

## Mzizi alignment / menus

`mzizi-alignment.test.ts`: "the header and the hero reach the phone menu only through PhoneMenu" is now "the phone menu is reached only through PhoneMenu, and only from MobileNav.tsx".

## Release note

Add to the next release's `releases/v<version>.md` (Improved): "The account menu moved to the bottom bar and My Location to the top. On a phone, your avatar (or the user icon when you are signed out) is now the first button in the bottom bar, and its menu opens upward. The My Location arrow moved to the top right, beside Share on a place and in the header on every other page."
