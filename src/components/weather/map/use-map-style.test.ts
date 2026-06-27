import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMapStyle } from "./use-map-style";

// Mock Zustand store
const mockTheme = vi.fn<() => string>().mockReturnValue("light");
vi.mock("@/lib/store", () => ({
  useAppStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: mockTheme() }),
}));

// Mock map-layers to avoid env var dependency in tests
vi.mock("@/lib/map-layers", () => ({
  MAPTILER_STYLE_LIGHT: "https://api.maptiler.com/maps/streets-v2/style.json?key=test",
  MAPTILER_STYLE_DARK: "https://api.maptiler.com/maps/streets-v2-dark/style.json?key=test",
  MAP_LAYERS: [],
  DEFAULT_LAYER: "precipitationIntensity",
  getMapLayerById: vi.fn(),
}));

// Mock React hooks
let capturedEffect: (() => (() => void) | void) | null = null;
let stateValue = false;
vi.mock("react", () => ({
  useState: (init: (() => boolean) | boolean) => {
    stateValue = typeof init === "function" ? init() : init;
    return [stateValue, (v: boolean) => { stateValue = v; }];
  },
  useEffect: (fn: () => void) => { capturedEffect = fn; },
}));

describe("useMapStyle", () => {
  beforeEach(() => {
    mockTheme.mockReturnValue("light");
    capturedEffect = null;
    stateValue = false;
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  it("exports useMapStyle as a function", () => {
    expect(typeof useMapStyle).toBe("function");
  });

  it("returns light MapTiler style URL when theme is light", () => {
    mockTheme.mockReturnValue("light");
    const result = useMapStyle();
    expect(result).toContain("streets-v2/style.json");
    expect(result).not.toContain("dark");
  });

  it("returns dark MapTiler style URL when theme is dark", () => {
    mockTheme.mockReturnValue("dark");
    const result = useMapStyle();
    expect(result).toContain("streets-v2-dark/style.json");
  });

  it("returns light style when theme is system and OS prefers light", () => {
    mockTheme.mockReturnValue("system");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const result = useMapStyle();
    expect(result).toContain("streets-v2/style.json");
    expect(result).not.toContain("dark");
  });

  it("returns dark style when theme is system and OS prefers dark", () => {
    mockTheme.mockReturnValue("system");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const result = useMapStyle();
    expect(result).toContain("streets-v2-dark/style.json");
  });

  it("returns a MapTiler URL (not Mapbox) for all themes", () => {
    for (const theme of ["light", "dark", "system"]) {
      mockTheme.mockReturnValue(theme);
      const result = useMapStyle();
      expect(result).toContain("maptiler.com");
      expect(result).not.toContain("mapbox.com");
    }
  });

  it("subscribes to matchMedia changes when theme is system", () => {
    mockTheme.mockReturnValue("system");
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener, removeEventListener }),
    });
    useMapStyle();
    expect(capturedEffect).toBeDefined();
    const cleanup = capturedEffect!();
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    if (typeof cleanup === "function") {
      cleanup();
      expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    }
  });

  it("does not subscribe to matchMedia when theme is not system", () => {
    mockTheme.mockReturnValue("dark");
    const addEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener, removeEventListener: vi.fn() }),
    });
    useMapStyle();
    if (capturedEffect) capturedEffect();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
