import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env.js";
import { log } from "../logger.js";
import * as schema from "./schema.js";

if (!env.databaseUrl) {
  log.warn("DATABASE_URL is not set; db client will not initialise until first use");
}

// Supabase (and any managed Postgres) require TLS. Local Postgres does not,
// so only enable SSL when the target is not localhost.
const isLocal = !env.databaseUrl || /@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl);

const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  log.error({ err }, "postgres pool error");
});

export const db = drizzle(pool, { schema });
export const rawPool = pool;
export { schema };
