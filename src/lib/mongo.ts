import { MongoClient, type MongoClientOptions } from "mongodb";

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI environment variable is not set");
}

const options: MongoClientOptions = {
  appName: "mukoko-weather",
  maxIdleTimeMS: 5000,
};

const client = new MongoClient(process.env.MONGODB_URI, options);

// In Vercel Functions, attach the pool for proper cleanup on suspension.
// This import is optional — it's a no-op outside Vercel.
try {
  // Dynamic import so builds don't fail if @vercel/functions isn't available
  import("@vercel/functions").then(({ attachDatabasePool }) => {
    attachDatabasePool(client);
  }).catch(() => {
    // Not running on Vercel — no-op
  });
} catch {
  // Static import resolution failed — no-op
}

// Module-scoped client: shared across all functions in the same process
export default client;

export function getDb() {
  return client.db("mukoko-weather");
}
