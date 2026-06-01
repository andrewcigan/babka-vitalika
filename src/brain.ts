import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { n8n } from "./n8n-client.js";
import { log } from "./logger.js";
import type { PendingEmail } from "./pendingActions.js";
import {
  addMessage,
  archiveChat,
  listRecentForChat,
} from "./db/repos/conversation-messages.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const MODEL = "claude-sonnet-4-6";
const MAX_ITERS = 6;
const MAX_HISTORY = 40;

type Msg = Anthropic.MessageParam;

// In-memory conversation history per chat. A bot restart clears it — acceptable
// for now; durable history (conversation_messages table) is a later step.
const historyByChat = new Map<number, Msg[]>();

export async function clearHistory(chatId: number): Promise<void> {
  historyByChat.delete(chatId);
  if (!env.databaseUrl) return;
  try {
    await archiveChat(BigInt(chatId));
  } catch (err) {
    log.warn({ err }, "could not archive conversation in db");
  }
}

async function loadHistoryFromDb(chatId: number): Promise<Msg[]> {
  if (!env.databaseUrl) return [];
  try {
    const rows = await listRecentForChat(BigInt(chatId), 30);
    const msgs: Msg[] = rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.contentText }));
    while (msgs.length > 0 && msgs[0]?.role !== "user") msgs.shift();
    return msgs;
  } catch (err) {
    log.warn({ err }, "could not load conversation history from db");
    return [];
  }
}

async function persistTurn(chatId: number, userText: string, assistantText: string): Promise<void> {
  if (!env.databaseUrl) return;
  try {
    await addMessage({ chatId: BigInt(chatId), role: "user", inputKind: "text", contentText: userText });
    await addMessage({
      chatId: BigInt(chatId),
      role: "assistant",
      inputKind: "text",
      contentText: assistantText,
    });
  } catch (err) {
    log.warn({ err }, "could not persist conversation turn to db");
  }
}

const tools: Anthropic.Tool[] = [
  {
    name: "list_events",
    description: "List the user's Google Calendar events in a time window.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of window, ISO 8601." },
        time_max: { type: "string", description: "End of window, ISO 8601." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "create_event",
    description: "Create a new Google Calendar event.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        start: { type: "string", description: "Start time, ISO 8601 with timezone offset." },
        end: { type: "string", description: "End time, ISO 8601 with timezone offset." },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "modify_event",
    description: "Change an existing event. Provide only the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        gcal_event_id: { type: "string", description: "ID from list_events." },
        summary: { type: "string" },
        start: { type: "string", description: "New start, ISO 8601 with offset." },
        end: { type: "string", description: "New end, ISO 8601 with offset." },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["gcal_event_id"],
    },
  },
  {
    name: "cancel_event",
    description: "Cancel (delete) an existing event by its ID.",
    input_schema: {
      type: "object",
      properties: {
        gcal_event_id: { type: "string", description: "ID from list_events." },
      },
      required: ["gcal_event_id"],
    },
  },
  {
    name: "list_new_mail",
    description: "List recent Gmail inbox messages received after a given time.",
    input_schema: {
      type: "object",
      properties: {
        after_epoch_seconds: { type: "number", description: "Unix epoch seconds lower bound." },
        max_results: { type: "number" },
      },
      required: ["after_epoch_seconds"],
    },
  },
  {
    name: "get_message",
    description: "Fetch the full content of a single Gmail message by ID.",
    input_schema: {
      type: "object",
      properties: {
        gmail_message_id: { type: "string" },
      },
      required: ["gmail_message_id"],
    },
  },
  {
    name: "get_availability",
    description: "Check whether the user is free or busy in a time window (free/busy lookup).",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of window, ISO 8601." },
        time_max: { type: "string", description: "End of window, ISO 8601." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "send_email",
    description:
      "Compose a NEW email. This does not send immediately — it shows the user a confirmation button.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body." },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "reply_email",
    description:
      "Reply to an existing email thread (get thread_id from list_new_mail or get_message). Does not send immediately — shows a confirmation button.",
    input_schema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        body: { type: "string", description: "Plain-text reply body." },
      },
      required: ["thread_id", "body"],
    },
  },
];

// Anthropic-hosted server tool: Claude runs the web search itself (no client execution).
const webSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: 5 } as const;

function systemPrompt(): string {
  const tz = env.productTimezone;
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());

  return [
    "You are a personal assistant for a busy executive, operating inside Telegram.",
    "You manage his Google Calendar and Gmail through the provided tools.",
    `The current date and time is ${local}. The user's timezone is ${tz}.`,
    `When creating or changing events, express start and end times as ISO 8601 with the correct ${tz} UTC offset (for example 2026-06-02T15:00:00-04:00).`,
    "Use the tools to read real data and to make changes — never invent events or emails.",
    "To modify or cancel an event you first need its gcal_event_id; if you don't have it, call list_events to find the right event.",
    "You can read recent mail, open a specific message, send a new email (send_email), and reply to a thread (reply_email).",
    "IMPORTANT: send_email and reply_email do NOT send right away — they show the user a confirmation button. Always present the draft (recipient, subject, body) clearly first, then ask the user to tap Send to confirm. Never claim an email was already sent; the user confirms it.",
    "You can check the user's free/busy availability with get_availability.",
    "You can search the web for up-to-date information and to look up companies, people, or websites the user mentions (including a specific URL).",
    "Keep replies short and plain for a chat app. You may use **bold** for key details, but do not use tables, headings, or links.",
    "Be concise and natural, like a helpful chief of staff. Confirm what you did in one short sentence. Ask a brief clarifying question only when the request is genuinely ambiguous.",
  ].join("\n");
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  webhookUrl: string,
  collector: { pending?: PendingEmail },
): Promise<unknown> {
  switch (name) {
    case "list_events":
      return n8n.listEvents(
        { timeMin: String(input.time_min), timeMax: String(input.time_max) },
        webhookUrl,
      );
    case "create_event":
      return n8n.createEvent(
        {
          summary: String(input.summary),
          startISO: String(input.start),
          endISO: String(input.end),
          description: input.description as string | undefined,
          location: input.location as string | undefined,
        },
        webhookUrl,
      );
    case "modify_event":
      return n8n.modifyEvent(
        {
          gcalEventId: String(input.gcal_event_id),
          changes: {
            summary: input.summary as string | undefined,
            startISO: input.start as string | undefined,
            endISO: input.end as string | undefined,
            description: input.description as string | undefined,
            location: input.location as string | undefined,
          },
        },
        webhookUrl,
      );
    case "cancel_event":
      return n8n.cancelEvent({ gcalEventId: String(input.gcal_event_id) }, webhookUrl);
    case "list_new_mail":
      return n8n.listNewMail(
        {
          afterEpochSeconds: Number(input.after_epoch_seconds),
          maxResults: input.max_results as number | undefined,
        },
        webhookUrl,
      );
    case "get_message":
      return n8n.getMessage({ gmailMessageId: String(input.gmail_message_id) }, webhookUrl);
    case "get_availability":
      return n8n.getAvailability(
        { timeMin: String(input.time_min), timeMax: String(input.time_max) },
        webhookUrl,
      );
    case "send_email":
      collector.pending = {
        kind: "send",
        to: String(input.to),
        subject: String(input.subject),
        body: String(input.body),
      };
      return { staged: true, note: "Draft shown to the user with a confirm button. Do NOT claim it was sent." };
    case "reply_email":
      collector.pending = {
        kind: "reply",
        threadId: String(input.thread_id),
        body: String(input.body),
      };
      return { staged: true, note: "Reply draft shown to the user with a confirm button. Do NOT claim it was sent." };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function trimHistory(history: Msg[]): void {
  while (history.length > MAX_HISTORY) history.shift();
  // History must start on a real user utterance, never on an orphaned tool_result.
  while (history.length > 0) {
    const first = history[0];
    if (first && first.role === "user" && typeof first.content === "string") break;
    history.shift();
  }
}

export async function think(
  chatId: number,
  userText: string,
  webhookUrl: string,
): Promise<{ text: string; pending?: PendingEmail }> {
  let history = historyByChat.get(chatId);
  if (!history) {
    history = await loadHistoryFromDb(chatId);
    historyByChat.set(chatId, history);
  }
  history.push({ role: "user", content: userText });

  let reply = "";
  const collector: { pending?: PendingEmail } = {};

  for (let i = 0; i < MAX_ITERS; i++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(),
      tools: [...tools, webSearchTool],
      messages: history,
    });

    history.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "pause_turn") {
      // A server tool (web search) paused the turn; re-call to let Claude continue.
      continue;
    }

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let content: string;
      try {
        const out = await runTool(tu.name, tu.input as Record<string, unknown>, webhookUrl, collector);
        content = JSON.stringify(out);
      } catch (e) {
        log.warn({ err: e, tool: tu.name }, "tool execution failed");
        content = JSON.stringify({ error: (e as Error).message });
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    history.push({ role: "user", content: toolResults });
  }

  if (!reply) reply = "Sorry, I couldn't finish that — try rephrasing the request.";

  trimHistory(history);
  historyByChat.set(chatId, history);
  await persistTurn(chatId, userText, reply);
  return { text: reply, pending: collector.pending };
}
