/**
 * The gateway's error body, read safely: `{detail: {error, error_description}}`
 * (nyuchi-api `routers/auth.py` `_oauth_error`), or the same keys at the top
 * level. Nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import { gatewayErrorCode, gatewayErrorDetail } from "./nyuchi-gateway";

const json = (body: unknown, status = 400) =>
  new Response(JSON.stringify(body), { status });

describe("gatewayErrorDetail", () => {
  it("reads the code and the description from detail", async () => {
    expect(
      await gatewayErrorDetail(
        json({
          detail: { error: "invalid_grant", error_description: "It ended." },
        }),
      ),
    ).toEqual({ code: "invalid_grant", description: "It ended." });
  });

  it("reads them at the top level too", async () => {
    expect(
      await gatewayErrorDetail(
        json({ error: "slow_down", error_description: "Wait." }),
      ),
    ).toEqual({ code: "slow_down", description: "Wait." });
  });

  it("keeps a code only if it is a short lower-case word", async () => {
    for (const error of ["Invalid-Grant", "x".repeat(49), "", 7, null]) {
      expect((await gatewayErrorDetail(json({ detail: { error } }))).code).toBe(
        null,
      );
    }
  });

  it("bounds the description and keeps it only if it is text", async () => {
    const long = await gatewayErrorDetail(
      json({ detail: { error: "a", error_description: "y".repeat(500) } }),
    );
    expect(long.description).toHaveLength(200);
    const notText = await gatewayErrorDetail(
      json({ detail: { error: "a", error_description: { x: 1 } } }),
    );
    expect(notText.description).toBeNull();
  });

  it("never throws: an unreadable body is nothing", async () => {
    const nothing = { code: null, description: null };
    expect(
      await gatewayErrorDetail(new Response("<html>", { status: 500 })),
    ).toEqual(nothing);
    expect(await gatewayErrorDetail(json(null))).toEqual(nothing);
    expect(await gatewayErrorDetail(json("text"))).toEqual(nothing);
  });

  it("gatewayErrorCode is its code, as before", async () => {
    expect(
      await gatewayErrorCode(json({ detail: { error: "person_not_found" } })),
    ).toBe("person_not_found");
    expect(
      await gatewayErrorCode(new Response("x", { status: 500 })),
    ).toBeNull();
  });
});
