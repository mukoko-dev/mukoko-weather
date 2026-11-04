/**
 * The problem answer and the bounded body read shared by the routes that
 * answer machines (`/api/profile/preferences` first).
 */
import { describe, it, expect, vi } from "vitest";

// The module imports AuthKit for `currentSession`; these helpers do not use it.
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: vi.fn() }));

import { problemResponse, readBoundedText } from "./api-route-guards";

describe("problemResponse", () => {
  it("is an RFC 9457 problem document with a stable code", async () => {
    const res = problemResponse(422, "unknown_field", "Not allowed.");
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      code: "unknown_field",
      detail: "Not allowed.",
    });
  });

  it("is never cached unless the caller says how", () => {
    expect(problemResponse(401, "x", "d").headers.get("cache-control")).toBe(
      "no-store",
    );
    expect(
      problemResponse(401, "x", "d", {
        cacheControl: "private, no-store",
      }).headers.get("cache-control"),
    ).toBe("private, no-store");
  });

  it("sends Retry-After only when asked", () => {
    expect(
      problemResponse(429, "x", "d").headers.get("retry-after"),
    ).toBeNull();
    expect(
      problemResponse(429, "x", "d", { retryAfterSeconds: 17 }).headers.get(
        "retry-after",
      ),
    ).toBe("17");
  });

  it("falls back to a generic title for a status it does not list", async () => {
    expect(
      ((await problemResponse(418, "x", "d").json()) as { title: string })
        .title,
    ).toBe("Error");
  });
});

describe("readBoundedText", () => {
  const req = (body: BodyInit | null, extra: RequestInit = {}) =>
    new Request("https://weather.mukoko.com/x", {
      method: "PUT",
      body,
      ...extra,
    });

  it("reads a body within the limit, multi-byte text included", async () => {
    const text = JSON.stringify({ name: "Zürich ☀" });
    expect(await readBoundedText(req(text), 1024)).toBe(text);
  });

  it("is an empty string for a request with no body", async () => {
    expect(await readBoundedText(req(null), 10)).toBe("");
  });

  it("is null once the body passes the limit, and exactly the limit is allowed", async () => {
    expect(await readBoundedText(req("x".repeat(11)), 10)).toBeNull();
    expect(await readBoundedText(req("x".repeat(10)), 10)).toBe("x".repeat(10));
  });

  it("counts bytes, not characters", async () => {
    expect(await readBoundedText(req("é".repeat(6)), 10)).toBeNull();
  });

  it("stops reading and cancels a stream that never ends", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(1_000));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readBoundedText(
      req(stream, { duplex: "half" } as RequestInit),
      2_500,
    );
    expect(result).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("keeps a multi-byte character that is split across chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });
    expect(
      await readBoundedText(req(stream, { duplex: "half" } as RequestInit), 10),
    ).toBe("é");
  });
});
