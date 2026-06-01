import { Bot, Context } from "grammy";
import { env } from "./env.js";
import { ui } from "./ui-strings.js";
import { n8n } from "./n8n-client.js";
import { startOfTodayISO, endOfTodayISO, addDaysISO, formatEventTimeRange } from "./time.js";
import { log } from "./logger.js";
import { getMode, setMode } from "./mode.js";

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.command("start", async (ctx) => {
    await ctx.reply(ui.start);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(ui.help, { parse_mode: "Markdown" });
  });

  // Hidden operator commands — intentionally absent from /help and the command menu.
  bot.command("test", async (ctx) => {
    if (!env.n8nWebhookUrlTest) {
      await ctx.reply(ui.testModeUnavailable);
      return;
    }
    if (ctx.chat) setMode(ctx.chat.id, "test");
    await ctx.reply(ui.testModeOn);
  });

  bot.command("prod", async (ctx) => {
    if (ctx.chat) setMode(ctx.chat.id, "prod");
    await ctx.reply(ui.testModeOff);
  });

  bot.command("today", (ctx) =>
    withProgress(ctx, async () => {
      const data = await n8n.listEvents(
        { timeMin: startOfTodayISO(), timeMax: endOfTodayISO() },
        webhookFor(ctx),
      );
      return badge(ctx, renderEvents(data.events, "Today"));
    }),
  );

  bot.command("tomorrow", (ctx) =>
    withProgress(ctx, async () => {
      const data = await n8n.listEvents(
        { timeMin: addDaysISO(startOfTodayISO(), 1), timeMax: addDaysISO(endOfTodayISO(), 1) },
        webhookFor(ctx),
      );
      return badge(ctx, renderEvents(data.events, "Tomorrow"));
    }),
  );

  bot.command("week", (ctx) =>
    withProgress(ctx, async () => {
      const data = await n8n.listEvents(
        { timeMin: startOfTodayISO(), timeMax: addDaysISO(endOfTodayISO(), 7) },
        webhookFor(ctx),
      );
      return badge(ctx, renderEvents(data.events, "Next 7 days"));
    }),
  );

  bot.command("mail", (ctx) =>
    withProgress(ctx, async () => {
      const afterEpoch = Math.floor(Date.now() / 1000) - 60 * 60;
      const data = await n8n.listNewMail(
        { afterEpochSeconds: afterEpoch, maxResults: 10 },
        webhookFor(ctx),
      );
      return badge(ctx, renderMail(data.messages));
    }),
  );

  bot.on("message:text", async (ctx) => {
    await ctx.reply(ui.unknownCommand);
  });

  bot.catch((err) => {
    log.error({ err: err.error }, "grammy uncaught error");
  });

  return bot;
}

function webhookFor(ctx: Context): string {
  if (getMode(ctx.chat?.id) === "test" && env.n8nWebhookUrlTest) {
    return env.n8nWebhookUrlTest;
  }
  return env.n8nWebhookUrl;
}

function badge(ctx: Context, text: string): string {
  return getMode(ctx.chat?.id) === "test" ? `${ui.testBadge}\n${text}` : text;
}

async function withProgress(ctx: Context, task: () => Promise<string>): Promise<void> {
  const placeholder = await ctx.reply(ui.thinking);
  let finalText: string;
  try {
    finalText = await task();
  } catch (err) {
    finalText = errorTextFor(err);
    log.error({ err }, "command failed");
  }
  try {
    await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, finalText);
  } catch (editErr) {
    // edit might fail if message older than 48h or chat unreachable — fall back to new reply
    log.warn({ err: editErr }, "editMessageText failed, falling back to reply");
    await ctx.reply(finalText);
  }
}

function errorTextFor(err: unknown): string {
  const code = (err as Error & { code?: string }).code;
  if (code === "google_unauthorized") return ui.errorUnauthorized;
  return ui.errorGeneric;
}

function renderEvents(
  events: {
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    html_link?: string;
  }[],
  heading: string,
): string {
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
    const from =
      (m.from ?? "(unknown sender)").replace(/<.*?>/, "").trim() || m.from || "(unknown sender)";
    const subj = (m.subject ?? "(no subject)").trim();
    const snip = (m.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    return `• ${from} — ${subj}\n  ${snip}`;
  });
  return `Recent inbox\n${lines.join("\n\n")}`;
}
