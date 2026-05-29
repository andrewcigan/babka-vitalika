import { Bot } from "grammy";
import { env } from "./env.js";
import { ui } from "./ui-strings.js";
import { n8n } from "./n8n-client.js";
import { startOfTodayISO, endOfTodayISO, addDaysISO, formatEventTimeRange } from "./time.js";
import { log } from "./logger.js";

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.command("start", async (ctx) => {
    await ctx.reply(ui.start);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(ui.help, { parse_mode: "Markdown" });
  });

  bot.command("today", async (ctx) => {
    await ctx.reply(ui.thinking);
    try {
      const data = await n8n.listEvents({
        timeMin: startOfTodayISO(),
        timeMax: endOfTodayISO(),
      });
      await ctx.reply(renderEvents(data.events, "Today"));
    } catch (err) {
      await replyWithError(ctx, err);
    }
  });

  bot.command("tomorrow", async (ctx) => {
    await ctx.reply(ui.thinking);
    try {
      const tomorrowStart = addDaysISO(startOfTodayISO(), 1);
      const tomorrowEnd = addDaysISO(endOfTodayISO(), 1);
      const data = await n8n.listEvents({ timeMin: tomorrowStart, timeMax: tomorrowEnd });
      await ctx.reply(renderEvents(data.events, "Tomorrow"));
    } catch (err) {
      await replyWithError(ctx, err);
    }
  });

  bot.command("week", async (ctx) => {
    await ctx.reply(ui.thinking);
    try {
      const start = startOfTodayISO();
      const end = addDaysISO(endOfTodayISO(), 7);
      const data = await n8n.listEvents({ timeMin: start, timeMax: end });
      await ctx.reply(renderEvents(data.events, "Next 7 days"));
    } catch (err) {
      await replyWithError(ctx, err);
    }
  });

  bot.command("mail", async (ctx) => {
    await ctx.reply(ui.thinking);
    try {
      const afterEpoch = Math.floor(Date.now() / 1000) - 60 * 60; // last hour
      const data = await n8n.listNewMail({ afterEpochSeconds: afterEpoch, maxResults: 10 });
      await ctx.reply(renderMail(data.messages));
    } catch (err) {
      await replyWithError(ctx, err);
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) {
      await ctx.reply(ui.unknownCommand);
      return;
    }
    await ctx.reply(ui.unknownCommand);
  });

  bot.catch((err) => {
    log.error({ err: err.error }, "grammy uncaught error");
  });

  return bot;
}

function renderEvents(events: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; html_link?: string }[], heading: string): string {
  if (!events.length) {
    return `${heading}\n${ui.noEvents}`;
  }
  const lines = events.slice(0, 20).map((e) => {
    const title = e.summary?.trim() || "(no title)";
    const when = formatEventTimeRange(e.start, e.end);
    return `• ${title} — ${when}`;
  });
  return `${heading}\n${lines.join("\n")}`;
}

function renderMail(messages: { from?: string; subject?: string; snippet?: string }[]): string {
  if (!messages.length) return ui.noMail;
  const lines = messages.slice(0, 10).map((m) => {
    const from = (m.from ?? "(unknown sender)").replace(/<.*?>/, "").trim() || m.from || "(unknown sender)";
    const subj = (m.subject ?? "(no subject)").trim();
    const snip = (m.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    return `• ${from} — ${subj}\n  ${snip}`;
  });
  return `Recent inbox\n${lines.join("\n\n")}`;
}

async function replyWithError(ctx: import("grammy").Context, err: unknown): Promise<void> {
  const code = (err as Error & { code?: string }).code;
  log.error({ err }, "command failed");
  if (code === "google_unauthorized") {
    await ctx.reply(ui.errorUnauthorized);
    return;
  }
  await ctx.reply(ui.errorGeneric);
}
