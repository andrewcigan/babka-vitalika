import { Bot, Context, InlineKeyboard } from "grammy";
import { env } from "./env.js";
import { ui } from "./ui-strings.js";
import { n8n } from "./n8n-client.js";
import { startOfTodayISO, endOfTodayISO, addDaysISO, formatEventTimeRange } from "./time.js";
import { log } from "./logger.js";
import { getMode, setMode } from "./mode.js";
import { think } from "./brain.js";
import { setPending, takePending, type PendingEmail } from "./pendingActions.js";

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
    const placeholder = await ctx.reply(ui.thinking);
    let result: Awaited<ReturnType<typeof think>>;
    try {
      result = await think(ctx.chat?.id ?? 0, ctx.message?.text ?? "", webhookFor(ctx));
    } catch (err) {
      log.error({ err }, "brain failed");
      result = { text: errorTextFor(err) };
    }
    if (result.pending && ctx.chat) setPending(ctx.chat.id, result.pending);
    const finalText =
      badge(ctx, result.text) + (result.pending ? draftPreview(result.pending) : "");
    const reply_markup = result.pending ? confirmKeyboard() : undefined;
    try {
      await ctx.api.editMessageText(
        placeholder.chat.id,
        placeholder.message_id,
        toTelegramHtml(finalText),
        { parse_mode: "HTML", reply_markup },
      );
    } catch {
      try {
        await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, finalText, {
          reply_markup,
        });
      } catch {
        await ctx.reply(finalText, { reply_markup });
      }
    }
  });

  bot.callbackQuery("confirm_send", async (ctx) => {
    const action = ctx.chat ? takePending(ctx.chat.id) : undefined;
    if (!action) {
      await ctx.answerCallbackQuery({ text: "Nothing to confirm." });
      return;
    }
    try {
      if (action.kind === "send") {
        await n8n.sendEmail(
          { to: action.to, subject: action.subject, body: action.body },
          webhookFor(ctx),
        );
      } else {
        await n8n.replyEmail({ threadId: action.threadId, body: action.body }, webhookFor(ctx));
      }
      await ctx.editMessageText("✅ Sent.");
    } catch (err) {
      log.error({ err }, "send failed");
      await ctx.editMessageText("Couldn't send — something went wrong. Nothing was sent.");
    }
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("cancel_send", async (ctx) => {
    if (ctx.chat) takePending(ctx.chat.id);
    await ctx.editMessageText("Cancelled — nothing was sent.");
    await ctx.answerCallbackQuery();
  });

  bot.catch((err) => {
    log.error({ err: err.error }, "grammy uncaught error");
  });

  return bot;
}

function draftPreview(p: PendingEmail): string {
  if (p.kind === "send") {
    return `\n\n**To:** ${p.to}\n**Subject:** ${p.subject}\n\n${p.body}`;
  }
  return `\n\n**Reply:**\n${p.body}`;
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Send", "confirm_send").text("❌ Cancel", "cancel_send");
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
  const html = toTelegramHtml(finalText);
  try {
    await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, html, {
      parse_mode: "HTML",
    });
  } catch (htmlErr) {
    // Malformed entities or a stale message — retry as plain text, then a fresh reply.
    log.warn({ err: htmlErr }, "HTML edit failed, retrying as plain text");
    try {
      await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, finalText);
    } catch {
      await ctx.reply(finalText);
    }
  }
}

// Telegram renders rich text only with a parse_mode. The brain (and our renderers)
// emit light Markdown (**bold**, `code`); translate it to Telegram-safe HTML,
// escaping &<> first so event titles or email text can't break the markup.
function toTelegramHtml(s: string): string {
  const escaped = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
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
