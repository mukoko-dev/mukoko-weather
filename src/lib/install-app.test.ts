import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo's tests run in node: stand in for the few browser globals used,
// before the module (which registers its listeners at load) is imported.
class FakeNavigator {}
const window = new EventTarget() as EventTarget & {
  matchMedia: (q: string) => { matches: boolean };
};
vi.stubGlobal("window", window);
vi.stubGlobal("Navigator", FakeNavigator);
vi.stubGlobal("navigator", new FakeNavigator());

const { _resetInstallState, canInstall, requestInstall, subscribeInstall } =
  await import("./install-app");

function fireBeforeInstallPrompt(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(async () => {});
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  window.dispatchEvent(event);
  return { event, prompt };
}

beforeEach(() => {
  _resetInstallState();
  window.matchMedia = () => ({ matches: false });
});

afterEach(() => {
  delete (FakeNavigator.prototype as { install?: unknown }).install;
});

describe("install-app", () => {
  it("offers nothing when the browser has neither mechanism", async () => {
    expect(canInstall()).toBe(false);
    expect(await requestInstall()).toBe("unavailable");
  });

  it("captures beforeinstallprompt, prevents the automatic prompt, and tells subscribers", () => {
    const seen = vi.fn();
    const off = subscribeInstall(seen);
    const { event } = fireBeforeInstallPrompt("accepted");
    expect(event.defaultPrevented).toBe(true);
    expect(canInstall()).toBe(true);
    expect(seen).toHaveBeenCalled();
    off();
  });

  it("prompts only when asked, and spends the single-use event", async () => {
    const { prompt } = fireBeforeInstallPrompt("accepted");
    expect(prompt).not.toHaveBeenCalled();
    expect(await requestInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(canInstall()).toBe(false);
  });

  it("reports a refusal as dismissed", async () => {
    fireBeforeInstallPrompt("dismissed");
    expect(await requestInstall()).toBe("dismissed");
  });

  it("prefers navigator.install() and calls it before awaiting anything", async () => {
    const install = vi.fn(async () => undefined);
    (FakeNavigator.prototype as { install?: unknown }).install = install;
    expect(canInstall()).toBe(true);
    const pending = requestInstall();
    // Synchronous: the call happened inside this tick, so activation is kept.
    expect(install).toHaveBeenCalledTimes(1);
    expect(await pending).toBe("accepted");
  });

  it("maps AbortError to dismissed and any other error to failed", async () => {
    const install = vi.fn();
    (FakeNavigator.prototype as { install?: unknown }).install = install;
    install.mockRejectedValueOnce(
      Object.assign(new Error("x"), { name: "AbortError" }),
    );
    expect(await requestInstall()).toBe("dismissed");
    install.mockRejectedValueOnce(new Error("boom"));
    expect(await requestInstall()).toBe("failed");
  });

  it("offers nothing when already running as the installed app", () => {
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("standalone"),
    })) as never;
    fireBeforeInstallPrompt("accepted");
    expect(canInstall()).toBe(false);
  });

  it("ignores a second tap while one is open", async () => {
    let release!: () => void;
    (FakeNavigator.prototype as { install?: unknown }).install = vi.fn(
      () => new Promise<void>((r) => (release = r)),
    );
    const first = requestInstall();
    expect(await requestInstall()).toBe("unavailable");
    release();
    expect(await first).toBe("accepted");
  });
});
