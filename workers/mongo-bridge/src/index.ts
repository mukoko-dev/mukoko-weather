// mukoko-weather-mongo-bridge. See wrangler.jsonc and handlers.ts.
//
// The Worker is a thin front: every request goes to ONE Durable Object, which
// owns the MongoClient (a MongoClient, Db or Collection cannot cross RPC, so
// all database logic runs inside the object). Holding the client in the
// object keeps the connection warm; a plain Worker would pay about 300 ms of
// connection setup per request.
//
// Only a service binding can reach this Worker (no route, no workers.dev).
// The service binding is the access control: the Rust Workers that bind it
// are the only callers, and they apply the per-client limits.

import { DurableObject } from "cloudflare:workers";
import { MongoClient } from "mongodb";
import { needsStores, route, fail, type Result, type Stores } from "./handlers";
import {
  deviceStore,
  fromMongo,
  historyStore,
  placeAliasStore,
  reportStore,
} from "./stores";

interface Env {
  MONGO_BRIDGE_DO: DurableObjectNamespace;
  /** Secrets Store binding: an object whose async `get()` returns the value. */
  MUKOKO_MONGODB_RW_URI?: { get(): Promise<string> } | string;
  /** Transition fallback: a plain wrangler secret of the plain name. */
  MONGODB_RW_URI?: string;
}

const MAX_BODY_BYTES = 16 * 1024;
/** A batch of archive days (up to 800 at about 1.2 KB each). */
const MAX_HISTORY_BODY_BYTES = 1024 * 1024;
const DEVICE_DB = "device";
const WEATHER_DB = "weather";
/** Read only: the platform slugs of a place (see `placeAliasStore`). */
const PLACES_DB = "places";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.MONGO_BRIDGE_DO.get(
      env.MONGO_BRIDGE_DO.idFromName("primary"),
    );
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function respond(r: Result): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** The read-write connection string: the Secrets Store first, the plain secret second. */
async function connectionString(env: Env): Promise<string | null> {
  const bound = env.MUKOKO_MONGODB_RW_URI;
  try {
    const value =
      typeof bound === "string" ? bound : bound ? await bound.get() : "";
    if (value && value.trim()) return value.trim();
  } catch {
    // Fall through to the plain secret; the reason is logged below, never the value.
    console.warn("mongo-bridge: Secrets Store read failed");
  }
  const plain = env.MONGODB_RW_URI;
  if (plain && plain.trim()) {
    console.warn(
      "mongo-bridge: using the plain MONGODB_RW_URI secret; add MUKOKO_MONGODB_RW_URI to the Secrets Store",
    );
    return plain.trim();
  }
  return null;
}

export class MongoBridge extends DurableObject<Env> {
  private client: Promise<MongoClient> | null = null;

  private open(): Promise<MongoClient> {
    if (!this.client) {
      this.client = (async () => {
        const uri = await connectionString(this.env);
        if (!uri) throw new Error("not_configured");
        const client = new MongoClient(uri, {
          appName: "mukoko-weather-mongo-bridge",
          maxPoolSize: 5,
          connectTimeoutMS: 5_000,
          serverSelectionTimeoutMS: 5_000,
          socketTimeoutMS: 8_000,
        });
        await client.connect();
        return client;
      })();
      // A failed connect must not be remembered: the next request retries.
      this.client.catch(() => {
        this.client = null;
      });
    }
    return this.client;
  }

  /** Drop the client after a connection-level failure; the next request reconnects. */
  private async reset(): Promise<void> {
    const pending = this.client;
    this.client = null;
    try {
      await (await pending)?.close();
    } catch {
      // Already broken; nothing to close.
    }
  }

  private async stores(): Promise<Stores> {
    const client = await this.open();
    return {
      devices: deviceStore(
        fromMongo(client.db(DEVICE_DB).collection("device_profiles")),
      ),
      reports: reportStore(
        fromMongo(client.db(WEATHER_DB).collection("weather_reports")),
      ),
      history: historyStore(
        fromMongo(client.db(WEATHER_DB).collection("weather_history")),
      ),
      places: placeAliasStore(
        fromMongo(client.db(PLACES_DB).collection("placesGeo")),
      ),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return this.health(url);
    if (!needsStores(url.pathname))
      return respond(fail(404, "not_found", "No such route."));

    let body: unknown;
    if (request.method === "POST" || request.method === "PATCH") {
      const text = await request.text();
      const cap =
        url.pathname === "/history/days"
          ? MAX_HISTORY_BODY_BYTES
          : MAX_BODY_BYTES;
      if (text.length > cap) {
        return respond(
          fail(413, "payload_too_large", "The request body is too large."),
        );
      }
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return respond(
          fail(422, "invalid_request", "The body is not valid JSON."),
        );
      }
    }

    try {
      const result = await route(
        {
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body,
        },
        {
          stores: await this.stores(),
          now: () => new Date(),
          randomId: () => crypto.randomUUID(),
        },
      );
      return respond(result);
    } catch (e) {
      // Name only: a driver message can carry host names or filters.
      const name = e instanceof Error ? e.name : "error";
      console.error(`mongo-bridge: ${name}`);
      if (
        name.startsWith("Mongo") ||
        (e instanceof Error && e.message === "not_configured")
      ) {
        await this.reset();
      }
      return respond(
        fail(503, "unavailable", "The data store is unavailable."),
      );
    }
  }

  /** `/health` never opens a connection; `?probe=mongo` pings the server. */
  private async health(url: URL): Promise<Response> {
    const base = { service: "mukoko-weather-mongo-bridge", status: "ok" };
    if (url.searchParams.get("probe") !== "mongo")
      return respond({ status: 200, body: base });
    try {
      const client = await this.open();
      await client.db(DEVICE_DB).command({ ping: 1 });
      return respond({
        status: 200,
        body: { ...base, mongo_probe: { ok: true } },
      });
    } catch (e) {
      await this.reset();
      const problem =
        e instanceof Error && e.message === "not_configured"
          ? "not_configured"
          : "unreachable";
      return respond({
        status: 200,
        body: { ...base, mongo_probe: { ok: false, problem } },
      });
    }
  }
}
