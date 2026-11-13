import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const vercel = JSON.parse(
  readFileSync(resolve(__dirname, "../../vercel.json"), "utf-8"),
) as { regions?: unknown };

describe("vercel.json function region (issue 551)", () => {
  // The app's on-demand pages run as Vercel functions, and the MongoDB Atlas
  // cluster is in AWS af-south-1 (Cape Town). Without `regions`, the project's
  // default region applies (Washington DC unless the project says otherwise),
  // so a visitor in Zimbabwe reaches a function an ocean away from both of
  // them. `cpt1` is Vercel's Cape Town region, in af-south-1 itself: the
  // nearest to the visitors and to the database.
  it("pins the functions to Cape Town, one region", () => {
    expect(vercel.regions).toEqual(["cpt1"]);
  });
});
