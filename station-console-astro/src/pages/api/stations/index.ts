import type { APIRoute } from "astro";
import { listStations, registerStation } from "../../../lib/bff/handlers";
import { bffRequest, withCaller } from "../../../lib/bff/route";

export const prerender = false;

export const GET: APIRoute = (context) => withCaller(context, (client, caller) => listStations(client, caller));

export const POST: APIRoute = (context) =>
  withCaller(context, (client, caller) => registerStation(client, caller, bffRequest(context)));
