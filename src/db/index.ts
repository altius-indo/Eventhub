import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0] | Database;

const globalForDb = globalThis as unknown as { __eventhubPool?: Pool; __eventhubDb?: Database };

function createDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = globalForDb.__eventhubPool ?? new Pool({ connectionString: url, max: 10 });
  globalForDb.__eventhubPool = pool;
  return drizzle(pool, { schema });
}

/** Lazily created so that importing modules never needs a database (e.g. at build time). */
export function getDb(): Database {
  if (!globalForDb.__eventhubDb) globalForDb.__eventhubDb = createDb();
  return globalForDb.__eventhubDb;
}

export { schema };
