import mongoose from "mongoose";

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

// Cached on `global` so hot-reload (dev) and repeated imports across route
// modules reuse a single connection instead of opening a new one each time.
declare global {
  var __mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = global.__mongooseCache ?? { conn: null, promise: null };
global.__mongooseCache = cache;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) {
    return cache.conn;
  }

  if (!cache.promise) {
    // Read lazily (not at module load time): this module is imported
    // transitively before the custom server's env-loading call runs (ESM
    // hoists all imports ahead of any top-level statement), so capturing
    // process.env.MONGODB_URI in a module-level constant would freeze it as
    // undefined.
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGODB_URI environment variable is not set.");
    }
    cache.promise = mongoose
      .connect(uri, {
        maxPoolSize: 10,
      })
      .then((m) => m);
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    throw err;
  }

  return cache.conn;
}
