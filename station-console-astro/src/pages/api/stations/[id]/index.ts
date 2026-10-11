import type { APIRoute } from "astro";
import { stationStatus } from "../../../../lib/bff/handlers";
import { bffRequest, withCaller } from "../../../../lib/bff/route";

export const prerender = false;

export const GET: APIRoute = (context) =>
  withCaller(context, (client, caller) =>
    stationStatus(client, caller, context.params.id ?? "", bffRequest(context)),
  );
