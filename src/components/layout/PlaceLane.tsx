"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavigationIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";
import { currentLocationSlug } from "@/lib/current-slug";
import { getScrollBehavior } from "@/lib/utils";
import {
  MY_LOCATION_NAME,
  homeChipShowsLabel,
  laneActiveIndex,
  laneChipName,
  laneChips,
  laneScrollLeft,
  type LaneChip,
} from "@/lib/location-pager";
import { trackPlaceChange, usePagerSequence } from "@/lib/use-location-pager";
import { handlePlaceLinkClick, isPlainLeftClick } from "@/lib/place-bus";

/**
 * The places lane in the middle of the phone bottom bar (option B, owner
 * 2026-11-02): My Location first and pinned, then one chip per saved or
 * suggested place, scrolling sideways beside it. It is the first part of the
 * `lane` slot of the vendored Mzizi bottom nav
 * (src/components/ui/mzizi-bottom-nav.tsx); Map is that bar's pinned item and
 * the account control (PhoneMenu) is the lane's last slot, after this
 * component (owner, 2026-11-11). Locations is the round list link at the top
 * of the page (LocationsLink).
 *
 * My Location sits OUTSIDE the scroller, so it can never scroll away and the
 * places are simply clipped at its edge (a sticky chip would have to hide
 * what slides behind it with an opaque patch, which shows as a seam on the
 * translucent bar). The start and end edges of the scroller fade while more
 * chips lie that way.
 *
 * The lane moves sideways only (owner, 2026-11-05). Two things keep it so:
 * `overflow-x: auto` alone makes the other axis `auto` too, so the scroller
 * sets `overflow-y-hidden`; and a chip's tap region (`.lark::after`) is sized
 * to the bar token, 72px, while the lane inside the bar's border is 70px, so
 * the list clips its content (`overflow-clip`) and the tap region is the
 * lane's own box, with nothing left over to drag.
 *
 * Every chip is a real link (`href`, so a new tab, middle click and no-JS
 * work) that a plain click turns into an in-place place switch through the
 * place stage (src/lib/place-bus.ts). The sequence is the swipe's
 * (usePagerSequence), so a tap and a swipe walk the same pages.
 */

interface PlaceLaneProps {
  pathname: string;
  savedLocations: readonly string[];
  selectedLocation: string;
}

/** The container: reads the sequence and routes clicks; no markup of its own. */
export function PlaceLane({
  pathname,
  savedLocations,
  selectedLocation,
}: PlaceLaneProps) {
  const from = currentLocationSlug(pathname, selectedLocation) ?? "";
  const router = useRouter();
  const sequence = usePagerSequence(savedLocations, selectedLocation);
  const locationLabels = useAppStore((s) => s.locationLabels);
  const locationNames = useAppStore((s) => s.locationNames);
  const chips = laneChips(sequence, (slug) =>
    laneChipName(slug, locationLabels, locationNames),
  );
  const activeIndex = laneActiveIndex(pathname, sequence, chips.length);

  const onChipClick = (
    event: MouseEvent<HTMLAnchorElement>,
    chip: LaneChip,
  ) => {
    // Count a place switch only when this tab really switches: not a
    // cmd/ctrl/middle click (a new tab) and not a tap on the current chip.
    if (chip.slug && isPlainLeftClick(event) && chip.slug !== from) {
      trackPlaceChange(chip.href, chip.slug, from);
    }
    handlePlaceLinkClick(event, chip.href, (href) => router.push(href));
  };

  return (
    <PlaceLaneView
      chips={chips}
      activeIndex={activeIndex}
      onChipClick={onChipClick}
    />
  );
}

interface PlaceLaneViewProps {
  chips: readonly LaneChip[];
  /** Index of the current page's chip, -1 when none is current. */
  activeIndex: number;
  onChipClick: (event: MouseEvent<HTMLAnchorElement>, chip: LaneChip) => void;
}

/**
 * The lane itself, free of the store and the router so it renders (and
 * tests) on its own. A labelled group, not a navigation landmark: the bar
 * already is one, and a second landmark inside it would nest them.
 */
export function PlaceLaneView({
  chips,
  activeIndex,
  onChipClick,
}: PlaceLaneViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  // More chips lie before / past the scroller's edges: it fades there.
  const [more, setMore] = useState({ before: false, after: false });
  const showHomeLabel = homeChipShowsLabel(chips.length);
  const home = chips.find((chip) => chip.kind === "home");
  const places = chips.filter((chip) => chip.kind === "place");

  const measureFade = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((prev) =>
      prev.before === before && prev.after === after ? prev : { before, after },
    );
  }, []);

  // Keep the current chip in view, centred in the scroller (on a route change
  // and on a swipe alike). My Location is outside the scroller: the lane then
  // returns to its start. With NO current chip (/locations, /explore) the lane
  // is left exactly where the person scrolled it. Re-run once the fonts are
  // in, since a chip's width changes with them.
  useEffect(() => {
    if (activeIndex < 0) return;
    const centre = () => {
      const scroller = scrollerRef.current;
      const active = activeRef.current;
      if (!scroller) return;
      scroller.scrollTo({
        left: laneScrollLeft(
          {
            viewport: scroller.clientWidth,
            content: scroller.scrollWidth,
            itemLeft: active?.offsetLeft ?? 0,
            itemWidth: active?.offsetWidth ?? 0,
          },
          active ? activeIndex : 0,
        ),
        behavior: getScrollBehavior(),
      });
    };
    centre();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) centre();
    });
    return () => {
      cancelled = true;
    };
  }, [activeIndex, chips.length]);

  // Fade state follows the lane's size and its content.
  useEffect(() => {
    measureFade();
    const scroller = scrollerRef.current;
    const list = listRef.current;
    if (!scroller || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureFade);
    observer.observe(scroller);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measureFade, chips.length]);

  return (
    <div
      role="group"
      aria-label="Places"
      className="relative flex h-full min-w-0 flex-1 items-center gap-2"
    >
      {home && (
        <Link
          href={home.href}
          prefetch={false}
          aria-label={MY_LOCATION_NAME}
          aria-current={
            chips.indexOf(home) === activeIndex ? "page" : undefined
          }
          title={MY_LOCATION_NAME}
          onClick={(event) => onChipClick(event, home)}
          className={`lark press-scale shrink-0 ${
            showHomeLabel ? "" : "min-w-[var(--touch-target-min)]"
          }`}
        >
          <NavigationIcon
            size={18}
            className={
              chips.indexOf(home) === activeIndex ? "fill-current" : ""
            }
          />
          {showHomeLabel && <span className="truncate">{home.name}</span>}
        </Link>
      )}
      {places.length > 0 && (
        <div
          ref={scrollerRef}
          onScroll={measureFade}
          data-fade-start={more.before ? "true" : undefined}
          data-fade-end={more.after ? "true" : undefined}
          className="sanderling scrollbar-hide h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        >
          {/* Named, so a screen reader does not count My Location (the link
              before it) as an item of this list. */}
          <ul
            ref={listRef}
            aria-label="Saved places and suggestions"
            // mzizi-spacing-exempt: a 4px side gutter that keeps a chip's border and focus ring off the clip edge, not a text inset (each .lark chip has the 14px floor); p-0 only resets the list
            className="relative m-0 flex h-full w-max list-none items-center gap-2 overflow-clip p-0 px-1"
          >
            {places.map((chip) => {
              const isActive = chips.indexOf(chip) === activeIndex;
              return (
                <li
                  key={chip.href}
                  ref={isActive ? activeRef : undefined}
                  className="shrink-0"
                >
                  <Link
                    href={chip.href}
                    prefetch={false}
                    aria-current={isActive ? "page" : undefined}
                    title={chip.name}
                    onClick={(event) => onChipClick(event, chip)}
                    className="lark press-scale"
                  >
                    <span className="truncate">{chip.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
