import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { n8n } from "./n8n-client.js";
import { log } from "./logger.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const MODEL = "claude-sonnet-4-6";
const MAX_ITERS = 6;
const MAX_HISTORY = 40;

type Msg = Anthropic.MessageParam;

// In-memory conversation history per chat. A bot restart clears it — acceptable
// for now; durable history (conversation_messages table) is a later step.
const historyByChat = new Map<number, Msg[]>();

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
];

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
    "You can read recent mail and open a specific message, but you cannot send email yet. If asked to send a message, say that sending isn't enabled yet.",
    "Keep replies short and plain for a chat app. You may use **bold** for key details, but do not use tables, headings, or links.",
    "Be concise and natural, like a helpful chief of staff. Confirm what you did in one short sentence. Ask a brief clarifying question only when the request is genuinely ambiguous.",
  ].join("\n");
}

async function runTool(name: string, input: Record<string, unknown>, webhookUrl: string): Promise<unknown> {
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

export async function think(chatId: number, userText: string, webhookUrl: string): Promise<string> {
  const history = historyByChat.get(chatId) ?? [];
  history.push({ role: "user", content: userText });

  let reply = "";

  for (let i = 0; i < MAX_ITERS; i++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(),
      tools,
      messages: history,
    });

    history.push({ role: "assistant", content: res.content });

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
        const out = await runTool(tu.name, tu.input as Record<string, unknown>, webhookUrl);
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
  return reply;
}
