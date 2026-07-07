import { MongoClient, type Db, type MongoClientOptions } from "mongodb";

const options: MongoClientOptions = {
  appName: "mukoko-weather",
  maxIdleTimeMS: 5000,
};

// Lazy-initialise: only create the client when MONGODB_URI is available.
// This prevents the app from crashing at module-load time when the env var
// is missing (e.g. local dev without a database).
let client: MongoClient | null = null;

function getClient(): MongoClient {
  if (!client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGODB_URI environment variable is not set");
    }
    client = new MongoClient(uri, options);

    // In Vercel Functions, attach the pool for proper cleanup on suspension.
    try {
      import("@vercel/functions").then(({ attachDatabasePool }) => {
        if (client) attachDatabasePool(client);
      }).catch(() => {
        // Not running on Vercel — no-op
      });
    } catch {
      // Static import resolution failed — no-op
    }
  }
  return client;
}

// Module-scoped client proxy: shared across all functions in the same process.
// Lazily delegates to the real MongoClient so imports never throw.
const clientProxy = new Proxy({} as MongoClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
export default clientProxy;

/**
 * Backward-compat accessor. Pre-Phase-0B this returned the single
 * `mukoko-weather` database. The Nyuchi Platform cluster now hosts 27
 * databases — mukoko's primary home is `weather`, so this is aliased to
 * {@link weatherDb}. New code should call the explicit `*Db()` accessors
 * below.
 */
export function getDb(): Db {
  return weatherDb();
}

// ---------------------------------------------------------------------------
// Platform database accessors (Phase 0B)
//
// See docs/mongodb-schema-map.md for the full schema map. Mukoko depends on
// six platform databases on the shared Nyuchi cluster.
// ---------------------------------------------------------------------------

/** Weather domain — cache, summaries, observations, stations, alerts, communityReports. */
export function weatherDb(): Db {
  return getClient().db("weather");
}

/** Locations / geography — places, placesGeo, categories, routes, conditionReports. */
export function placesDb(): Db {
  return getClient().db("places");
}

/** Users / auth — persons, credentials, activityLog. */
export function identityDb(): Db {
  return getClient().db("identity");
}

/** AI / chatbot — conversations, messages, guardrails, knowledgeBase, preferences. */
export function shamwariDb(): Db {
  return getClient().db("shamwari");
}

/** Device registry — devices, commands, telemetry, deviceHistory. */
export function deviceDb(): Db {
  return getClient().db("device");
}

/** Provider configs — providers, providerConfigurations, standards. */
export function integrationsDb(): Db {
  return getClient().db("integrations");
}

/** Platform-wide cross-app collections — `apiKeys`, entities, billing, etc. */
export function platformDb(): Db {
  return getClient().db("platform");
}

/** Organisations / entities — `entities`, `memberships`, etc. */
export function entityDb(): Db {
  return getClient().db("entity");
}
