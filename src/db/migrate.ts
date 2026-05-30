import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rawPool } from "./client.js";
import { log } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));
// in dev: src/db; in prod build: dist/db. migrations live at repo root /drizzle.
const migrationsDir = join(here, "..", "..", "drizzle");

async function ensureMigrationsTable(): Promise<void> {
  await rawPool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const res = await rawPool.query<{ name: string }>("SELECT name FROM _migrations");
  return new Set(res.rows.map((r) => r.name));
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable();
  const done = await appliedMigrations();

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    const client = await rawPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log.info({ migration: file }, "migration applied");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      log.error({ err, migration: file }, "migration failed, rolled back");
      throw err;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

// CLI: `node dist/db/migrate.js` для ручного прогона.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations()
    .then(({ applied, skipped }) => {
      log.info({ applied, skipped_count: skipped.length }, "migrations done");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, "migrations failed");
      process.exit(1);
    });
}
