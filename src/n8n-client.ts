import { request } from "undici";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";

export type CalendarEventOut = {
  gcal_event_id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  html_link?: string;
  all_day?: boolean;
};

export type GmailMessageOut = {
  gmail_message_id: string;
  thread_id?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  received_epoch_seconds?: number;
};

export type CreateEventResult = {
  gcal_event_id: string;
  gcal_etag?: string;
  html_link?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

export type GmailMessageDetail = {
  gmail_message_id: string;
  from?: string;
  to?: string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
  received_epoch_seconds?: number;
};

type WebhookResponse<T> =
  | { ok: true; action: string; idempotency_key: string; data: T }
  | { ok: false; action: string; idempotency_key: string; error: { code: string; message: string } };

async function call<T>(
  action: string,
  payload: Record<string, unknown>,
  webhookUrl: string = env.n8nWebhookUrl,
): Promise<T> {
  const body = {
    action,
    idempotency_key: randomUUID(),
    payload,
  };

  const res = await request(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": env.n8nWebhookSecret,
    },
    body: JSON.stringify(body),
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });

  const raw = await res.body.text();
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(`n8n webhook rejected auth (status ${res.statusCode})`);
  }
  if (res.statusCode >= 500) {
    throw new Error(`n8n webhook 5xx (${res.statusCode}): ${raw.slice(0, 200)}`);
  }

  let parsed: WebhookResponse<T>;
  try {
    parsed = JSON.parse(raw) as WebhookResponse<T>;
  } catch (e) {
    throw new Error(`n8n webhook returned non-JSON (${res.statusCode}): ${raw.slice(0, 200)}`);
  }

  if (!parsed.ok) {
    const code = parsed.error?.code ?? "unknown";
    const message = parsed.error?.message ?? "unknown error";
    if (code === "google_unauthorized") {
      const err = new Error("google_unauthorized");
      (err as Error & { code?: string }).code = code;
      throw err;
    }
    throw new Error(`n8n action ${action} failed: ${code} — ${message}`);
  }

  return parsed.data;
}

export const n8n = {
  listEvents(params: { timeMin: string; timeMax: string }, webhookUrl?: string) {
    return call<{ events: CalendarEventOut[] }>(
      "calendar.listEvents",
      { time_min: params.timeMin, time_max: params.timeMax },
      webhookUrl,
    );
  },

  listNewMail(params: { afterEpochSeconds: number; maxResults?: number }, webhookUrl?: string) {
    return call<{ messages: GmailMessageOut[] }>(
      "gmail.listNew",
      { after_epoch_seconds: params.afterEpochSeconds, max_results: params.maxResults ?? 25 },
      webhookUrl,
    );
  },

  createEvent(
    params: {
      summary: string;
      startISO: string;
      endISO: string;
      description?: string;
      location?: string;
    },
    webhookUrl?: string,
  ) {
    return call<CreateEventResult>(
      "calendar.createEvent",
      {
        summary: params.summary,
        start: { dateTime: params.startISO },
        end: { dateTime: params.endISO },
        description: params.description,
        location: params.location,
      },
      webhookUrl,
    );
  },

  modifyEvent(
    params: {
      gcalEventId: string;
      changes: {
        summary?: string;
        startISO?: string;
        endISO?: string;
        description?: string;
        location?: string;
      };
    },
    webhookUrl?: string,
  ) {
    const c = params.changes;
    return call<CreateEventResult>(
      "calendar.modifyEvent",
      {
        gcal_event_id: params.gcalEventId,
        changes: {
          summary: c.summary,
          start: c.startISO ? { dateTime: c.startISO } : undefined,
          end: c.endISO ? { dateTime: c.endISO } : undefined,
          description: c.description,
          location: c.location,
        },
      },
      webhookUrl,
    );
  },

  cancelEvent(params: { gcalEventId: string }, webhookUrl?: string) {
    return call<{ gcal_event_id: string; status: string }>(
      "calendar.cancelEvent",
      { gcal_event_id: params.gcalEventId },
      webhookUrl,
    );
  },

  getMessage(params: { gmailMessageId: string }, webhookUrl?: string) {
    return call<GmailMessageDetail>(
      "gmail.getMessage",
      { gmail_message_id: params.gmailMessageId },
      webhookUrl,
    );
  },

  getAvailability(params: { timeMin: string; timeMax: string }, webhookUrl?: string) {
    return call<{ availability: unknown }>(
      "calendar.getAvailability",
      { time_min: params.timeMin, time_max: params.timeMax },
      webhookUrl,
    );
  },

  sendEmail(params: { to: string; subject: string; body: string }, webhookUrl?: string) {
    return call<{ gmail_message_id: string; thread_id?: string; sent: boolean }>(
      "gmail.send",
      { to: params.to, subject: params.subject, body: params.body },
      webhookUrl,
    );
  },

  replyEmail(params: { threadId: string; body: string }, webhookUrl?: string) {
    return call<{ gmail_message_id: string; thread_id?: string; sent: boolean }>(
      "gmail.reply",
      { thread_id: params.threadId, body: params.body },
      webhookUrl,
    );
  },
};
