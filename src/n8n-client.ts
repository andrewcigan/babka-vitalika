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

type WebhookResponse<T> =
  | { ok: true; action: string; idempotency_key: string; data: T }
  | { ok: false; action: string; idempotency_key: string; error: { code: string; message: string } };

async function call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const body = {
    action,
    idempotency_key: randomUUID(),
    payload,
  };

  const res = await request(env.n8nWebhookUrl, {
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
  listEvents(params: { timeMin: string; timeMax: string }) {
    return call<{ events: CalendarEventOut[] }>("calendar.listEvents", {
      time_min: params.timeMin,
      time_max: params.timeMax,
    });
  },

  listNewMail(params: { afterEpochSeconds: number; maxResults?: number }) {
    return call<{ messages: GmailMessageOut[] }>("gmail.listNew", {
      after_epoch_seconds: params.afterEpochSeconds,
      max_results: params.maxResults ?? 25,
    });
  },

  // write-actions сюда же добавим, когда подключим LLM-логику (feat-006+)
};
