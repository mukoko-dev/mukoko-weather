import type { APIRoute } from "astro";
import { submitReading } from "../../../../lib/bff/handlers";
import { bffRequest, withCaller } from "../../../../lib/bff/route";

export const prerender = false;

export const POST: APIRoute = (context) =>
  withCaller(context, (client, caller) =>
    submitReading(client, caller, context.params.id ?? "", bffRequest(context)),
  );
