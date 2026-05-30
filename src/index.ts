import { createBot } from "./bot.js";
import { startHealthServer } from "./health.js";
import { log } from "./logger.js";
import { env } from "./env.js";
import { runMigrations } from "./db/migrate.js";

async function main(): Promise<void> {
  if (env.databaseUrl) {
    log.info("running database migrations");
    const { applied, skipped } = await runMigrations();
    log.info({ applied, skipped_count: skipped.length }, "migrations done");
  } else {
    log.warn("DATABASE_URL not set — skipping migrations and DB-backed features");
  }

  const health = startHealthServer();
  const bot = createBot();

  process.on("SIGTERM", async () => {
    log.info("SIGTERM received, shutting down");
    try {
      await bot.stop();
    } catch (e) {
      log.warn({ err: e }, "bot.stop threw");
    }
    await health.close();
    process.exit(0);
  });

  log.info("starting telegram bot (long polling)");
  await bot.start({
    onStart: (botInfo) => log.info({ username: botInfo.username }, "bot online"),
  });
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
