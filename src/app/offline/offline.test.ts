import { readFileSync } from "fs";
import { resolve } from "path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/components/weather/DeviceSnapshot", () => ({
  DeviceSnapshot: () => null,
}));
vi.mock("@/lib/store", () => ({
  useAppStore: (select: (s: { selectedLocation: string }) => unknown) =>
    select({ selectedLocation: "" }),
}));
vi.mock("@/lib/rxdb/weather-places", () => ({ recallPlace: async () => null }));

const read = (f: string) => readFileSync(resolve(__dirname, f), "utf-8");

describe("/offline: the shell when there is no network", () => {
  it("renders a main landmark and a way to try again before anything is read from the device", async () => {
    const { OfflineShell } = await import("./OfflineShell");
    const html = renderToString(createElement(OfflineShell));
    expect(html).toContain('<main id="main-content">');
    expect(html).toContain("You&#x27;re offline");
    expect(html).toContain('href="/"');
    expect(html.match(/<main/g)).toHaveLength(1);
  });

  it("paints the last place from the device, never from the network", () => {
    const shell = read("OfflineShell.tsx");
    expect(shell).toContain("recallPlace(slug)");
    expect(shell).toContain("LAST_HOME_PLACE_KEY");
    expect(shell).toContain(
      "<DeviceSnapshot view={view} showHeader={false} />",
    );
    expect(shell).not.toMatch(/\bfetch\(/);
  });

  it("is a static route with no visitor data of its own", () => {
    const page = read("page.tsx");
    expect(page).not.toContain("getCurrentUser");
    expect(page).not.toContain("cookies(");
    expect(page).toContain("<OfflineShell />");
  });
});
