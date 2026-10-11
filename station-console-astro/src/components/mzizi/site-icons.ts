/**
 * The glyphs behind the Icon component: one stroke path per name, drawn on a
 * 24px grid at 1.75 weight. Framework-free, so the Astro `Icon`
 * (`site-icon.astro`), the React `Icon` (`site-icon.tsx`) and typed navigation
 * data (`IconName`) share one set.
 *
 * Add a glyph by adding one entry here. Keep the set curated to what the sites
 * actually use rather than pulling a whole icon font.
 */
export const ICON_PATHS = {
  "arrow-right": "M17 8l4 4m0 0l-4 4m4-4H3",
  "arrow-up-right": "M7 17L17 7M17 7H7M17 7v10",
  check: "M5 13l4 4L19 7",
  "chevron-down": "M19 9l-7 7-7-7",
  "chevron-right": "M9 5l7 7-7 7",
  external:
    "M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14",
  close: "M6 18L18 6M6 6l12 12",
  menu: "M4 6h16M4 12h16M4 18h16",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  terminal: "M4 17l6-5-6-5M12 19h8",
  // App and console glyphs (0.3.0): navigation, the shell and the top bar.
  home: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0",
  users:
    "M9 11a4 4 0 100-8 4 4 0 000 8zM2 20a7 7 0 0114 0M16 3.5a4 4 0 010 7.5M18 13.5a7 7 0 014 6.5",
  building:
    "M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16M16 9h2a2 2 0 012 2v10M3 21h18M8 7h4M8 11h4M8 15h4",
  newspaper:
    "M4 5h13v14a2 2 0 002 2H6a2 2 0 01-2-2V5zM17 9h3v10a2 2 0 01-2 2M8 9h5M8 13h5M8 17h3",
  calendar: "M4 6h16v15H4zM4 10h16M8 3v4M16 3v4",
  globe:
    "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
  truck:
    "M2 6h12v10H2zM14 9h4l4 4v3h-8M6 19a2 2 0 100-4 2 2 0 000 4zM18 19a2 2 0 100-4 2 2 0 000 4z",
  bag: "M5 8h14l-1 13H6L5 8zM9 8V6a3 3 0 016 0v2",
  cloud: "M7 18a4 4 0 01-.5-7.97A6 6 0 0118 9a4.5 4.5 0 01-.5 9H7z",
  key: "M8 15a4 4 0 100-8 4 4 0 000 8zM12 11h9M18 11v3M15 11v2",
  "shield-check": "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4",
  chart: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3",
  sparkles:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  "panel-left": "M4 4h16v16H4zM9 4v16",
  "chevrons-up-down": "M8 9l4-4 4 4M8 15l4 4 4-4",
  "log-out": "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  book: "M4 5a2 2 0 012-2h13v14H6a2 2 0 00-2 2V5zM4 19a2 2 0 002 2h13v-4",
  inbox: "M3 13l3-8h12l3 8v6H3v-6zM3 13h5l1 3h6l1-3h5",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  wallet: "M3 6h18v12H3zM3 10h18M7 15h3",
  "map-pin":
    "M12 21s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  file: "M14 3H6v18h12V7l-4-4zM14 3v4h4M9 13h6M9 17h6",
  workflow:
    "M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  "badge-check":
    "M9 12l2 2 4-4M12 3l2.4 1.8 3-.3.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.3L12 21l-2.4-1.8-3 .3-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .3L12 3z",
  message: "M4 5h16v11H8l-4 4V5z",
  heart: "M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z",
  flame:
    "M12 21a6 6 0 006-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-3-2 2-3 4-3 7a6 6 0 006 6z",
  target: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 15a3 3 0 100-6 3 3 0 000 6z",
  clipboard: "M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M9 12h6M9 16h4",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3",
  // Media and file glyphs (nyuchi-tools): the image Studio and its tools.
  image: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 100-.01",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  download: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14",
  upload: "M12 20V9m0 0l-4 4m4-4l4 4M5 4h14",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66 5.66l1.41 1.41M4.93 4.93l1.41 1.41m11.32 0l1.41-1.41M4.93 19.07l1.41-1.41M12 17a5 5 0 100-10 5 5 0 000 10z",
  moon: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z",
  history: "M3 12a9 9 0 103-6.7M3 4v4h4M12 7v5l3 2",
} as const;

/** Every glyph name. */
export type IconName = keyof typeof ICON_PATHS;
