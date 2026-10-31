import { describe, it, expect, vi } from "vitest";

const mockLoad = vi.fn();
vi.mock("@/app/[location]/load-location", () => ({
  loadLocation: (slug: string) => mockLoad(slug),
}));

const { resolveLocationParam } = await import("./load-location");

describe("resolveLocationParam", () => {
  it("resolves the slug from the route params through the shared loader", async () => {
    mockLoad.mockResolvedValue({ slug: "harare" });
    const loc = await resolveLocationParam(
      Promise.resolve({ location: "harare" }),
    );
    expect(mockLoad).toHaveBeenCalledWith("harare");
    expect(loc).toEqual({ slug: "harare" });
  });

  it("returns null for an unknown slug, leaving notFound() to the caller", async () => {
    mockLoad.mockResolvedValue(null);
    await expect(
      resolveLocationParam(Promise.resolve({ location: "nowhere" })),
    ).resolves.toBeNull();
  });
});
