import { createBot } from "./bot.js";
import { startHealthServer } from "./health.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
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
