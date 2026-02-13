import { MongoClient, type MongoClientOptions } from "mongodb";

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

export function getDb() {
  return getClient().db("mukoko-weather");
}
