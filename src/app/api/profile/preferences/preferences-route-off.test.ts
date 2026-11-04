/**
 * With the switches as shipped (off), the route answers 503
 * `preferences_unavailable` to a signed-in person and touches neither the
 * limiter nor storage. Anonymous callers still get 401, so the route does not
 * confirm anything to the signed-out. Nothing here mocks the switches: flipping
 * `PERSON_PREFERENCES_READY` must change this file in the same pull request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

vi.mock("@/lib/observability", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const store = vi.hoisted(() => ({ read: vi.fn(), merge: vi.fn() }));
vi.mock("@/lib/person-preferences-store", () => ({
  personPreferencesStore: store,
}));

import { GET, PUT } from "./route";
import {
  PERSON_PREFERENCES_READY,
  PERSON_SAVED_PLACES_READY,
} from "@/lib/person-preferences-switches";
import { activity } from "@/lib/person-preferences-fixtures";

const SITE = "https://weather.mukoko.com";
const put = () =>
  new Request(`${SITE}/api/profile/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: SITE },
    body: JSON.stringify({ activities: [activity()] }),
  }) as never;

beforeEach(() => {
  for (const m of [withAuthMock, rateLimitMock, store.read, store.merge])
    m.mockReset();
  withAuthMock.mockResolvedValue({ user: { id: "user_1" } });
  rateLimitMock.mockResolvedValue({ allowed: true });
});

describe("the route as shipped", () => {
  it("has both switches off", () => {
    expect(PERSON_PREFERENCES_READY).toBe(false);
    expect(PERSON_SAVED_PLACES_READY).toBe(false);
  });

  it("GET is 503 preferences_unavailable and reads nothing", async () => {
    const res = await GET();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "preferences_unavailable",
    );
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it("PUT is 503 preferences_unavailable and writes nothing", async () => {
    const res = await PUT(put());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "preferences_unavailable",
    );
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(store.merge).not.toHaveBeenCalled();
  });

  it("is still 401 for the signed-out, and the CSRF guard still comes first", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    expect((await GET()).status).toBe(401);
    expect((await PUT(put())).status).toBe(401);
    const crossSite = new Request(`${SITE}/api/profile/preferences`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{}",
    }) as never;
    expect((await PUT(crossSite)).status).toBe(403);
  });
});
