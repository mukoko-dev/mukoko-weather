import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMapStyle } from "./use-map-style";

// Mock Zustand store
const mockTheme = vi.fn<() => string>().mockReturnValue("light");
vi.mock("@/lib/store", () => ({
  useAppStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: mockTheme() }),
}));

// Mock React hooks — useMapStyle uses useState and useEffect
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
    // Default: OS prefers light
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  it("exports useMapStyle as a function", () => {
    expect(typeof useMapStyle).toBe("function");
  });

  it('returns "streets-v12" when theme is "light"', () => {
    mockTheme.mockReturnValue("light");
    const result = useMapStyle();
    expect(result).toBe("streets-v12");
  });

  it('returns "dark-v11" when theme is "dark"', () => {
    mockTheme.mockReturnValue("dark");
    const result = useMapStyle();
    expect(result).toBe("dark-v11");
  });

  it('returns "streets-v12" when theme is "system" and OS prefers light', () => {
    mockTheme.mockReturnValue("system");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const result = useMapStyle();
    expect(result).toBe("streets-v12");
  });

  it('returns "dark-v11" when theme is "system" and OS prefers dark', () => {
    mockTheme.mockReturnValue("system");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const result = useMapStyle();
    expect(result).toBe("dark-v11");
  });

  it("subscribes to matchMedia changes when theme is system", () => {
    mockTheme.mockReturnValue("system");
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener, removeEventListener }),
    });
    useMapStyle();
    // The effect should have been captured
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
    if (capturedEffect) {
      capturedEffect();
    }
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("returns only valid Mapbox style IDs for light theme", () => {
    mockTheme.mockReturnValue("light");
    expect(["streets-v12", "dark-v11"]).toContain(useMapStyle());
  });

  it("returns only valid Mapbox style IDs for system theme", () => {
    mockTheme.mockReturnValue("system");
    expect(["streets-v12", "dark-v11"]).toContain(useMapStyle());
  });
});
