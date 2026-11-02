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
import { currentLocationSlug, displayNameFromSlug } from "@/lib/current-slug";
import { getScrollBehavior } from "@/lib/utils";
import {
  homeChipShowsLabel,
  laneActiveIndex,
  laneChips,
  laneScrollLeft,
  type LaneChip,
} from "@/lib/location-pager";
import { trackPlaceChange, usePagerSequence } from "@/lib/use-location-pager";
import { handlePlaceLinkClick } from "@/lib/place-bus";

/**
 * The places lane in the middle of the phone bottom bar (option B, owner
 * 2026-11-02): My Location first and pinned, then one chip per saved or
 * suggested place, scrolling sideways beside it. It is the `lane` slot of the
 * vendored Mzizi bottom nav (src/components/ui/mzizi-bottom-nav.tsx); Map and
 * Locations are that bar's pinned items.
 *
 * My Location sits OUTSIDE the scroller, so it can never scroll away and the
 * places are simply clipped at its edge (a sticky chip would have to hide
 * what slides behind it with an opaque patch, which shows as a seam on the
 * translucent bar). The start and end edges of the scroller fade while more
 * chips lie that way.
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
  const chips = laneChips(sequence);
  const activeIndex = laneActiveIndex(pathname, sequence, chips.length);

  const onChipClick = (
    event: MouseEvent<HTMLAnchorElement>,
    chip: LaneChip,
  ) => {
    if (chip.slug) trackPlaceChange(chip.href, chip.slug, from);
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
  const [home, ...places] = chips;

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
  // returns to its start.
  useEffect(() => {
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
      className={`relative flex h-full min-w-0 flex-1 items-center gap-1.5 ${
        places.length === 0 ? "justify-center" : ""
      }`}
    >
      <Link
        href={home.href}
        prefetch={false}
        aria-label="My Location"
        aria-current={activeIndex === 0 ? "page" : undefined}
        title="My Location"
        onClick={(event) => onChipClick(event, home)}
        className={`lark shrink-0 ${
          showHomeLabel ? "" : "min-w-[var(--touch-target-min)] px-0"
        }`}
      >
        <NavigationIcon
          size={18}
          className={activeIndex === 0 ? "fill-current" : ""}
        />
        {showHomeLabel && <span className="truncate">My Location</span>}
      </Link>
      {places.length > 0 && (
        <div
          ref={scrollerRef}
          onScroll={measureFade}
          data-fade-start={more.before ? "true" : undefined}
          data-fade-end={more.after ? "true" : undefined}
          className="sanderling scrollbar-hide h-full min-w-0 flex-1 overflow-x-auto"
        >
          <ul
            ref={listRef}
            className="relative m-0 flex h-full w-max list-none items-center gap-1.5 p-0 px-1"
          >
            {places.map((chip, i) => {
              const isActive = i + 1 === activeIndex;
              const name = displayNameFromSlug(chip.slug ?? "");
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
                    title={name}
                    onClick={(event) => onChipClick(event, chip)}
                    className="lark"
                  >
                    <span className="truncate">{name}</span>
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
