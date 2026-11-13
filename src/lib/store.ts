import { create } from "zustand";
import { updatePreferences, initRxDBBridge, getDeviceId } from "./rxdb/bridge";
import {
  holdStorageForFirstScreen,
  isStorageHeld,
  storageMayStart,
} from "./rxdb/start-gate";
import type { PreferencesDocType } from "./rxdb/schemas";
import { getFeatureFlag } from "./feature-flags";
// Types only: the sync code itself is imported dynamically, behind the flag.
import type { SyncableState, SyncedPatch } from "./rxdb/couch-docs";
import type { SyncBridge } from "./rxdb/couch-sync";
// The one tiny, dependency-free comparison the engine uses too.
import { sameSyncableState } from "./rxdb/sync-state";
import { isLocationSlug } from "./current-slug";
import {
  canonicalSlug,
  migrateSlugPrefs,
  slugPrefsChanged,
} from "./slug-migration";
import { isPresetAnchor, type PresetAnchor } from "./location-presets";
import {
  readStoredTheme,
  rememberTheme,
  resolveTheme,
  type ThemePreference,
} from "./theme";
import {
  DEFAULT_NOTIFICATION_PREFS,
  mergeNotificationPrefs,
  sanitiseNotificationPrefs,
  type NotificationPrefs,
} from "./notification-prefs";

export type { ThemePreference };
export { resolveTheme };

/** Tabs of the My Weather modal (ids match MyWeatherModal's TabsTrigger values). */
export type MyWeatherTab = "location" | "activities" | "settings";

/** What the notifications centre shows: the list of alerts, or the settings. */
export type NotificationsView = "list" | "settings";

/**
 * Opens the report wizard already on a report type (and, when the alert is
 * about another place than the one on screen, for that place). Both parts are
 * optional and validated by `cleanReportPreset`.
 */
export interface ReportPreset {
  reportType?: string;
  locationSlug?: string;
}

/**
 * A preset the wizard can trust. `openReportModal` is used directly as a click
 * handler in places, so it can be handed a DOM event: anything that is not a
 * plain object with a well-formed type or slug is no preset.
 */
export function cleanReportPreset(value: unknown): ReportPreset | null {
  if (!value || typeof value !== "object") return null;
  const { reportType, locationSlug } = value as Record<string, unknown>;
  const preset: ReportPreset = {};
  if (typeof reportType === "string" && /^[a-z]+(-[a-z]+)*$/.test(reportType)) {
    preset.reportType = reportType;
  }
  if (typeof locationSlug === "string" && isLocationSlug(locationSlug)) {
    preset.locationSlug = locationSlug;
  }
  return preset.reportType || preset.locationSlug ? preset : null;
}

// ---------------------------------------------------------------------------
// Shamwari context — carries weather/location/summary data between pages
// ---------------------------------------------------------------------------

const SHAMWARI_CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ShamwariContext {
  source: "location" | "explore" | "history";
  locationSlug?: string;
  locationName?: string;
  province?: string;
  weatherSummary?: string;
  temperature?: number;
  condition?: string;
  season?: string;
  activities: string[];
  /** History-specific context */
  historyDays?: number;
  historyAnalysis?: string;
  /** Explore-specific context */
  exploreQuery?: string;
  /** Set automatically — context expires after 10 minutes */
  timestamp: number;
}

/** Check if a Shamwari context is still valid (< 10 min old) */
export function isShamwariContextValid(
  ctx: ShamwariContext | null,
): ctx is ShamwariContext {
  if (!ctx) return false;
  return Date.now() - ctx.timestamp < SHAMWARI_CONTEXT_TTL_MS;
}

/**
 * Apply the resolved theme to the DOM, and record the choice on this device
 * (`rememberTheme`) so the next first paint can settle it before the
 * preferences load from IndexedDB. Every path that changes the theme (the
 * visitor's tap, the preferences read at start-up, another tab, another
 * device's sync) goes through here, so the record cannot drift from them.
 */
function applyTheme(pref: ThemePreference) {
  rememberTheme(pref);
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
  document.documentElement.setAttribute("data-brand", "mukoko-weather");
}

/** Maximum number of saved locations per user */
export const MAX_SAVED_LOCATIONS = 10;

/** Default section order for the location page primary column */
export const DEFAULT_SECTION_ORDER = [
  "current",
  "hourlyScroll",
  "communityLane",
  "atmospheric",
  "reports",
  "activityInvite",
  "agriculture",
  "aiSummary",
  "aiChat",
  "enso",
] as const;

const SECTION_ORDER_KEY = "mukoko-section-order";

/**
 * The hero (`current`) is pinned first. It is painted white on the page sky
 * and the phone header is not drawn over it, so it cannot sit below another
 * section (white text on the light page surface, and no header). Every path
 * that sets or restores the order goes through `pinHeroFirst`, which also
 * migrates layouts saved before the hero was pinned.
 */
export const PINNED_FIRST_SECTION = "current";

/** `order` with the hero moved to the front (unchanged when it has none). */
export function pinHeroFirst(order: readonly string[]): string[] {
  if (!order.includes(PINNED_FIRST_SECTION)) return [...order];
  return [
    PINNED_FIRST_SECTION,
    ...order.filter((id) => id !== PINNED_FIRST_SECTION),
  ];
}

const DEFAULT_SECTION_INDEX = new Map<string, number>(
  DEFAULT_SECTION_ORDER.map((id, i) => [id, i]),
);

/**
 * Reconcile a persisted section order against the current DEFAULT_SECTION_ORDER.
 *
 * A user who saved a layout months ago has an array that predates any sections
 * added since (e.g. `hourlyScroll`, `reports`, `aiSummary`, `aiChat`, plus any
 * new multi-model/nowcast sections). The dashboard only renders ids present in
 * the order, so those newer sections would silently never appear. Conversely a
 * removed/renamed section id lingering in storage would be a dead entry.
 *
 * This UNIONs the two: keep the stored ids that still exist in DEFAULT (drop the
 * rest), then splice in every missing DEFAULT id at its default position (before
 * the first existing section that follows it in the default layout). The user's
 * custom ordering of the sections they DID arrange is preserved, except that
 * the hero is always pinned first (`pinHeroFirst`): a layout saved when the
 * hero was draggable is migrated here.
 *
 * Exported for testing.
 */
export function mergeSectionOrder(stored: string[]): string[] {
  // Drop ids that are no longer part of the default schema, and de-dupe.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of stored) {
    if (DEFAULT_SECTION_INDEX.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  // Insert any missing default ids at their default position. Processing in
  // default order keeps newly-inserted ids in their relative default order.
  for (const id of DEFAULT_SECTION_ORDER) {
    if (seen.has(id)) continue;
    const defaultIdx = DEFAULT_SECTION_INDEX.get(id)!;
    let insertPos = result.findIndex(
      (existing) =>
        (DEFAULT_SECTION_INDEX.get(existing) ?? Infinity) > defaultIdx,
    );
    if (insertPos === -1) insertPos = result.length;
    result.splice(insertPos, 0, id);
    seen.add(id);
  }
  return pinHeroFirst(result);
}

/** Read the raw persisted section order from localStorage, or null if absent/invalid. */
function readStoredSectionOrder(): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(SECTION_ORDER_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveSectionOrder(order: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* ignore */
  }
}

interface AppState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  selectedLocation: string; // slug — currently viewed location
  setSelectedLocation: (slug: string) => void;
  /** Saved locations list (up to MAX_SAVED_LOCATIONS slugs, ordered) */
  savedLocations: string[];
  /** Add a location to saved list (no-op if already saved or at cap) */
  saveLocation: (slug: string) => void;
  /** Remove a location from saved list */
  removeLocation: (slug: string) => void;
  /**
   * The visitor's Home location slug (⌂ on the Locations list), or null.
   * Persisted in RxDB; device-local for now (not yet part of the device sync).
   */
  homeLocation: string | null;
  /** Set (or clear with null) the Home location */
  setHomeLocation: (slug: string | null) => void;
  /** Suggested places the visitor hid on the Locations list (device-local). */
  hiddenPresetSlugs: string[];
  /** Hide one suggested place (no-op if already hidden). */
  hidePresetLocation: (slug: string) => void;
  /** Bring back every hidden suggested place ("Restore suggested places"). */
  restorePresetLocations: () => void;
  /** Rough position the suggested places are chosen around, or null before first visit. */
  presetAnchor: PresetAnchor | null;
  /** Set the suggestion anchor; ignored when the value is not a valid position. */
  setPresetAnchor: (anchor: PresetAnchor) => void;
  /** Custom labels for saved locations (e.g., "Home", "Work") — keyed by slug */
  locationLabels: Record<string, string>;
  /** Set a custom label for a saved location */
  setLocationLabel: (slug: string, label: string) => void;
  /** Display names seen this session from search/GPS results (not persisted) */
  locationNames: Record<string, string>;
  rememberLocationName: (slug: string, name: string) => void;
  selectedActivities: string[]; // activity IDs from src/lib/activities.ts
  toggleActivity: (id: string) => void;
  /** Windy-style forecast model preference (Open-Meteo model id or "best_match") */
  selectedForecastModel: string;
  setSelectedForecastModel: (model: string) => void;
  myWeatherOpen: boolean;
  /** Tab the My Weather modal opens on (not persisted). */
  myWeatherTab: MyWeatherTab;
  openMyWeather: (tab?: MyWeatherTab) => void;
  closeMyWeather: () => void;
  hasOnboarded: boolean;
  completeOnboarding: () => void;
  /** Shamwari context — carries weather/location data between pages (transient, not persisted) */
  shamwariContext: ShamwariContext | null;
  /** Accepts context with optional timestamp — auto-sets timestamp to Date.now() */
  setShamwariContext: (
    ctx: Omit<ShamwariContext, "timestamp"> & { timestamp?: number },
  ) => void;
  clearShamwariContext: () => void;
  /** Weather report modal visibility (transient) */
  reportModalOpen: boolean;
  /** Set when the wizard was opened from an alert (transient). */
  reportPreset: ReportPreset | null;
  openReportModal: (preset?: ReportPreset) => void;
  closeReportModal: () => void;
  /**
   * Alerts: which kinds the person wants and their quiet hours. Persisted in
   * RxDB, device-local for now (not yet part of the device sync).
   */
  notificationPrefs: NotificationPrefs;
  setNotificationPrefs: (patch: Partial<NotificationPrefs>) => void;
  /** The notifications centre (bell, phone menu, settings entry points). Transient. */
  notificationsOpen: boolean;
  notificationsView: NotificationsView;
  openNotifications: (view?: NotificationsView) => void;
  closeNotifications: () => void;
  /** User-defined section order for the location page primary column */
  sectionOrder: string[];
  setSectionOrder: (order: string[]) => void;
  /**
   * Load the persisted section order from localStorage AFTER hydration and apply
   * it (unioned with the current defaults). Call this from a client `useEffect`
   * so the server and first client render both use `DEFAULT_SECTION_ORDER` —
   * reading localStorage during store init would desync SSR and hydration.
   */
  hydrateSectionOrder: () => void;
}

const THEME_CYCLE: ThemePreference[] = ["light", "dark", "system"];

/**
 * Module-level hydration flag — set once RxDB bridge finishes loading
 * preferences into the store. Components that depend on persisted state
 * (e.g. a component checking hasOnboarded) should wait for this to
 * avoid a flash of incorrect content.
 */
let _hasHydrated = false;

const _hydrationListeners = new Set<() => void>();

function markStoreHydrated(): void {
  if (_hasHydrated) return;
  _hasHydrated = true;
  for (const listener of _hydrationListeners) listener();
}

/** Check if the Zustand store has finished hydrating from RxDB. */
export function hasStoreHydrated(): boolean {
  return _hasHydrated;
}

/**
 * Subscribe to the moment the store finishes hydrating. Backs
 * `useStoreHydrated()`, which needs a re-render when RxDB resolves AFTER React
 * has hydrated (slow IndexedDB): a plain `hasStoreHydrated()` read would stay
 * stale until some unrelated re-render.
 */
export function subscribeStoreHydrated(listener: () => void): () => void {
  _hydrationListeners.add(listener);
  return () => _hydrationListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Flag to suppress RxDB writes during bridge hydration (prevents echo loop)
// ---------------------------------------------------------------------------
let _suppressRxDBWrites = false;

export const useAppStore = create<AppState>()((set) => ({
  theme: "system" as ThemePreference,
  setTheme: (theme: ThemePreference) => {
    applyTheme(theme);
    set({ theme });
    if (!_suppressRxDBWrites) updatePreferences({ theme });
  },
  toggleTheme: () =>
    set((state) => {
      const idx = THEME_CYCLE.indexOf(state.theme);
      const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      applyTheme(next);
      if (!_suppressRxDBWrites) updatePreferences({ theme: next });
      return { theme: next };
    }),
  selectedLocation: "",
  setSelectedLocation: (rawSlug) => {
    // Legacy seed slugs never enter the store; canonical only (#317).
    const slug = canonicalSlug(rawSlug);
    set({ selectedLocation: slug });
    if (!_suppressRxDBWrites) updatePreferences({ selectedLocation: slug });
  },
  homeLocation: null,
  setHomeLocation: (slug) => {
    const next = slug && slug.length > 0 ? canonicalSlug(slug) : null;
    set({ homeLocation: next });
    if (!_suppressRxDBWrites) updatePreferences({ homeLocation: next });
  },
  hiddenPresetSlugs: [],
  hidePresetLocation: (slug) =>
    set((state) => {
      const canonical = canonicalSlug(slug);
      if (
        !isLocationSlug(canonical) ||
        state.hiddenPresetSlugs.includes(canonical)
      ) {
        return {};
      }
      const next = [...state.hiddenPresetSlugs, canonical];
      if (!_suppressRxDBWrites) updatePreferences({ hiddenPresetSlugs: next });
      return { hiddenPresetSlugs: next };
    }),
  restorePresetLocations: () =>
    set((state) => {
      if (state.hiddenPresetSlugs.length === 0) return {};
      if (!_suppressRxDBWrites) updatePreferences({ hiddenPresetSlugs: [] });
      return { hiddenPresetSlugs: [] };
    }),
  presetAnchor: null,
  setPresetAnchor: (anchor) => {
    if (!isPresetAnchor(anchor)) return;
    const next = { lat: anchor.lat, lon: anchor.lon };
    set({ presetAnchor: next });
    if (!_suppressRxDBWrites) updatePreferences({ presetAnchor: next });
  },
  savedLocations: [],
  saveLocation: (rawSlug) =>
    set((state) => {
      const slug = canonicalSlug(rawSlug);
      if (
        state.savedLocations.some((saved) => canonicalSlug(saved) === slug) ||
        state.savedLocations.length >= MAX_SAVED_LOCATIONS
      ) {
        return {};
      }
      const next = [...state.savedLocations, slug];
      if (!_suppressRxDBWrites) updatePreferences({ savedLocations: next });
      return { savedLocations: next };
    }),
  removeLocation: (rawSlug) =>
    set((state) => {
      // Remove the place whichever of its two spellings was saved.
      const slug = canonicalSlug(rawSlug);
      const next = state.savedLocations.filter(
        (s) => canonicalSlug(s) !== slug,
      );
      const { [slug]: _, ...remainingLabels } = state.locationLabels;
      if (!_suppressRxDBWrites)
        updatePreferences({
          savedLocations: next,
          locationLabels: remainingLabels,
        });
      return { savedLocations: next, locationLabels: remainingLabels };
    }),
  locationNames: {},
  rememberLocationName: (slug, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) =>
      state.locationNames[slug] === trimmed
        ? state
        : { locationNames: { ...state.locationNames, [slug]: trimmed } },
    );
  },
  locationLabels: {},
  setLocationLabel: (slug, label) =>
    set((state) => {
      const trimmed = label.trim();
      let nextLabels: Record<string, string>;
      if (trimmed) {
        nextLabels = { ...state.locationLabels, [slug]: trimmed };
      } else {
        const { [slug]: _, ...rest } = state.locationLabels;
        nextLabels = rest;
      }
      if (!_suppressRxDBWrites)
        updatePreferences({ locationLabels: nextLabels });
      return { locationLabels: nextLabels };
    }),
  selectedActivities: [],
  toggleActivity: (id) =>
    set((state) => {
      const next = state.selectedActivities.includes(id)
        ? state.selectedActivities.filter((a) => a !== id)
        : [...state.selectedActivities, id];
      if (!_suppressRxDBWrites) updatePreferences({ selectedActivities: next });
      return { selectedActivities: next };
    }),
  selectedForecastModel: "best_match",
  setSelectedForecastModel: (model) => {
    set({ selectedForecastModel: model });
    if (!_suppressRxDBWrites)
      updatePreferences({ selectedForecastModel: model });
  },
  myWeatherOpen: false,
  myWeatherTab: "location",
  openMyWeather: (tab) =>
    set({ myWeatherOpen: true, myWeatherTab: tab ?? "location" }),
  closeMyWeather: () => set({ myWeatherOpen: false, myWeatherTab: "location" }),
  hasOnboarded: false,
  completeOnboarding: () => {
    set({ hasOnboarded: true });
    if (!_suppressRxDBWrites) updatePreferences({ hasOnboarded: true });
  },
  shamwariContext: null,
  setShamwariContext: (ctx) =>
    set({ shamwariContext: { ...ctx, timestamp: Date.now() } }),
  clearShamwariContext: () => set({ shamwariContext: null }),
  reportModalOpen: false,
  reportPreset: null,
  openReportModal: (preset) =>
    set({ reportModalOpen: true, reportPreset: cleanReportPreset(preset) }),
  closeReportModal: () => set({ reportModalOpen: false, reportPreset: null }),
  notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
  setNotificationPrefs: (patch) =>
    set((state) => {
      const next = mergeNotificationPrefs(state.notificationPrefs, patch);
      if (!_suppressRxDBWrites) updatePreferences({ notificationPrefs: next });
      return { notificationPrefs: next };
    }),
  notificationsOpen: false,
  notificationsView: "list",
  openNotifications: (view = "list") =>
    set({
      notificationsOpen: true,
      notificationsView: view === "settings" ? "settings" : "list",
    }),
  closeNotifications: () => set({ notificationsOpen: false }),
  // Initialise to the defaults on BOTH the server and the first client render so
  // hydration matches. The persisted order (if any) is applied post-hydration via
  // `hydrateSectionOrder()`, mirroring how RxDB-backed prefs are deferred.
  sectionOrder: [...DEFAULT_SECTION_ORDER],
  setSectionOrder: (order) => {
    const pinned = pinHeroFirst(order);
    saveSectionOrder(pinned);
    set({ sectionOrder: pinned });
  },
  hydrateSectionOrder: () => {
    const stored = readStoredSectionOrder();
    if (!stored) return;
    const merged = mergeSectionOrder(stored);
    set({ sectionOrder: merged });
    // Normalise storage so future loads (and the drag handler) start from the
    // reconciled order. Only rewrite when the merge actually changed something.
    if (
      merged.length !== stored.length ||
      merged.some((id, i) => id !== stored[i])
    ) {
      saveSectionOrder(merged);
    }
  },
}));

// ---------------------------------------------------------------------------
// RxDB initialization — replaces old device-sync + persist middleware
// ---------------------------------------------------------------------------

/**
 * Initialize the local-first storage layer:
 *   1. RxDB bridge: migrates localStorage → IndexedDB, hydrates Zustand
 *   2. Replication: bidirectional sync with Python backend
 *
 * Call once from a client-side layout/provider component.
 */
export function initializeDeviceSync(): void {
  if (typeof window === "undefined") return;

  // Until the preferences have been read from IndexedDB, the store holds its
  // default theme ("system"). The theme this device recorded stands in for
  // them (src/lib/theme.ts): the page was already painted in it by the script
  // in the document head, and it is what a fresh preferences document is seeded
  // with if IndexedDB was cleared. The preferences, once read, decide.
  const recorded = readStoredTheme();
  if (recorded && useAppStore.getState().theme === "system") {
    useAppStore.setState({ theme: recorded });
  }

  // On the home page the database waits for the weather to be on screen and
  // the browser to be idle (src/lib/rxdb/start-gate.ts, issue 551): the theme
  // is already settled above, and the place and its forecast come from
  // localStorage. Everywhere else the wait is over at once.
  holdStorageForFirstScreen(window.location?.pathname ?? "");
  if (isStorageHeld()) void storageMayStart().then(startDeviceSync);
  else startDeviceSync();
}

/** Opens the preferences database and starts replication. */
function startDeviceSync(): void {
  initRxDBBridge({
    applyToStore: (incoming: Partial<PreferencesDocType>) => {
      // Canonical-slug migration (#317), once and idempotent: every path that
      // reaches the store (RxDB hydrate, multi-tab change, device-sync pull,
      // legacy localStorage import) lands here, so a stored `harare` becomes
      // `harare--ksy4dd1` the first time it is read, and a second pass
      // changes nothing.
      const prefs = migrateSlugPrefs(incoming);
      const slugsMigrated = slugPrefsChanged(incoming, prefs);
      _suppressRxDBWrites = true;
      try {
        if (prefs.theme !== undefined) {
          applyTheme(prefs.theme as ThemePreference);
          useAppStore.setState({ theme: prefs.theme as ThemePreference });
        }
        if (prefs.selectedLocation !== undefined) {
          useAppStore.setState({ selectedLocation: prefs.selectedLocation });
        }
        if (prefs.savedLocations !== undefined) {
          useAppStore.setState({ savedLocations: prefs.savedLocations });
        }
        if (prefs.locationLabels !== undefined) {
          useAppStore.setState({ locationLabels: prefs.locationLabels });
        }
        if (prefs.selectedActivities !== undefined) {
          useAppStore.setState({
            selectedActivities: prefs.selectedActivities,
          });
        }
        if (prefs.hasOnboarded !== undefined) {
          useAppStore.setState({ hasOnboarded: prefs.hasOnboarded });
        }
        if (prefs.selectedForecastModel !== undefined) {
          useAppStore.setState({
            selectedForecastModel: prefs.selectedForecastModel,
          });
        }
        if (prefs.homeLocation !== undefined) {
          useAppStore.setState({ homeLocation: prefs.homeLocation });
        }
        if (prefs.hiddenPresetSlugs !== undefined) {
          useAppStore.setState({
            hiddenPresetSlugs: prefs.hiddenPresetSlugs,
          });
        }
        if (prefs.presetAnchor !== undefined) {
          useAppStore.setState({
            presetAnchor: isPresetAnchor(prefs.presetAnchor)
              ? prefs.presetAnchor
              : null,
          });
        }
        if (prefs.notificationPrefs !== undefined) {
          useAppStore.setState({
            notificationPrefs: sanitiseNotificationPrefs(
              prefs.notificationPrefs,
            ),
          });
        }
      } finally {
        _suppressRxDBWrites = false;
      }
      // Write the canonical slugs back so IndexedDB and, through replication,
      // the device profile carry them too. The write re-enters this function
      // with nothing left to migrate, so it cannot loop.
      if (slugsMigrated) {
        updatePreferences({
          selectedLocation: prefs.selectedLocation,
          savedLocations: prefs.savedLocations,
          homeLocation: prefs.homeLocation,
          hiddenPresetSlugs: prefs.hiddenPresetSlugs,
          locationLabels: prefs.locationLabels,
        });
      }
    },

    getCurrentPrefs: () => {
      const s = useAppStore.getState();
      return {
        theme: s.theme,
        selectedLocation: s.selectedLocation,
        savedLocations: s.savedLocations,
        locationLabels: s.locationLabels,
        selectedActivities: s.selectedActivities,
        hasOnboarded: s.hasOnboarded,
        selectedForecastModel: s.selectedForecastModel,
        homeLocation: s.homeLocation,
        hiddenPresetSlugs: s.hiddenPresetSlugs,
        presetAnchor: s.presetAnchor,
        notificationPrefs: s.notificationPrefs,
      };
    },
  })
    .then(() => {
      markStoreHydrated();
      startCouchSyncIfEnabled();
      // Replication (RxDB's replication plugin and rxjs) loads after first
      // paint and only here, never with the page's first-load JavaScript.
      return import("./rxdb/replication").then((m) => m.startReplication());
    })
    .catch(() => {
      // RxDB init failed — store still works with defaults.
      // This handles cases like private browsing where IndexedDB may be unavailable.
      markStoreHydrated();
    });
}

// ---------------------------------------------------------------------------
// CouchDB sync (flagged, #396) — preferences and activities only
// ---------------------------------------------------------------------------

/** The slice of state the CouchDB sync reads and writes (`couch-docs.ts`). */
function pickSyncableState(
  s: Pick<AppState, "theme" | "selectedForecastModel" | "selectedActivities">,
): SyncableState {
  return {
    theme: s.theme,
    selectedForecastModel: s.selectedForecastModel,
    selectedActivities: [...s.selectedActivities],
  };
}

function readSyncableState(): SyncableState {
  return pickSyncableState(useAppStore.getState());
}

/**
 * Apply what the person's other devices changed. Goes through the store's own
 * setters, so the change is also persisted to this device's preferences
 * (RxDB) and applied to the page (the theme attribute) exactly as if the
 * person had made it here.
 */
export function applySyncedPreferences(patch: SyncedPatch): void {
  if (
    patch.theme !== undefined &&
    THEME_CYCLE.includes(patch.theme as ThemePreference)
  ) {
    useAppStore.getState().setTheme(patch.theme as ThemePreference);
  }
  if (patch.selectedForecastModel !== undefined) {
    useAppStore
      .getState()
      .setSelectedForecastModel(patch.selectedForecastModel);
  }
  if (patch.selectedActivities !== undefined) {
    const next = [...patch.selectedActivities];
    useAppStore.setState({ selectedActivities: next });
    void updatePreferences({ selectedActivities: next });
  }
}

/**
 * Start the CouchDB sync when `FLAGS.couch_sync` is on. With the flag off
 * (the default) this reads one flag and returns: nothing is imported, no
 * request is made. The sync code itself loads only here, after first paint.
 */
function startCouchSyncIfEnabled(): void {
  if (!getFeatureFlag("couch_sync")) return;
  void import("./rxdb/couch-sync-start")
    .then((m) => m.startCouchSync(createSyncBridge(), getDeviceId()))
    .catch(() => undefined);
}

/**
 * What the sync reads, hears about and writes (`SyncBridge`, `couch-sync.ts`).
 * It hears about a change only when the VALUE of a synced setting differs (the
 * preferences bridge sets a fresh array of the same activities on every
 * emission of the preferences document, which is no change), and it is told
 * where the change came from: `"applied"` when it happened inside the
 * preferences bridge's `applyToStore` (the hydration, a `/v1/devices` pull,
 * another tab), which is not an edit the person made here and must not be
 * written to the cloud as one, `"person"` for everything else.
 */
export function createSyncBridge(): SyncBridge {
  return {
    read: readSyncableState,
    subscribe: (listener) =>
      useAppStore.subscribe((state, prev) => {
        if (
          sameSyncableState(pickSyncableState(state), pickSyncableState(prev))
        ) {
          return;
        }
        listener(_suppressRxDBWrites ? "applied" : "person");
      }),
    apply: applySyncedPreferences,
  };
}
