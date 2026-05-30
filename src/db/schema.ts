import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Канон-схема — drizzle/0001_init.sql.
// Здесь только типизация для runtime — индексы и триггеры в SQL миграции.

export const conversationMessages = pgTable("conversation_messages", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
  role: text("role").notNull().$type<"user" | "assistant" | "system">(),
  inputKind: text("input_kind").notNull().$type<"text" | "voice" | "callback" | "command">(),
  contentText: text("content_text").notNull(),
  voiceTranscriptRaw: text("voice_transcript_raw"),
  telegramVoiceFileId: text("telegram_voice_file_id"),
  llmMetadataJson: jsonb("llm_metadata_json"),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calendarEvents = pgTable("calendar_events", {
  id: text("id").primaryKey(),
  dedupKey: text("dedup_key").notNull().unique(),
  sourceMessageId: bigint("source_message_id", { mode: "bigint" }).notNull(),
  sourceChatId: bigint("source_chat_id", { mode: "bigint" }).notNull(),
  gcalEventId: text("gcal_event_id"),
  gcalEtag: text("gcal_etag"),
  gcalCalendarId: text("gcal_calendar_id").notNull().default("primary"),
  title: text("title").notNull(),
  sourcePhrase: text("source_phrase"),
  description: text("description"),
  location: text("location"),
  allDay: boolean("all_day").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  timezone: text("timezone").notNull().default("America/New_York"),
  createdBy: text("created_by")
    .notNull()
    .$type<
      "detector_text" | "detector_voice" | "user_callback" | "reschedule_followup" | "recovery"
    >(),
  status: text("status")
    .notNull()
    .$type<"pending" | "active" | "cancelled" | "superseded">(),
  detectorConfidence: real("detector_confidence"),
  rawGcalResponseJson: jsonb("raw_gcal_response_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
});

export const processedEmails = pgTable("processed_emails", {
  gmailMessageId: text("gmail_message_id").primaryKey(),
  threadId: text("thread_id").notNull(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  subject: text("subject"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  summaryText: text("summary_text").notNull(),
  summaryActionItemsJson: jsonb("summary_action_items_json"),
  summaryUrgency: text("summary_urgency").$type<"high" | "medium" | "low">(),
  summaryLlmMetadataJson: jsonb("summary_llm_metadata_json"),
  notificationChatId: bigint("notification_chat_id", { mode: "bigint" }).notNull(),
  notificationTelegramMessageId: bigint("notification_telegram_message_id", { mode: "bigint" }),
  notificationStatus: text("notification_status")
    .notNull()
    .$type<"pending" | "sent" | "failed">(),
  notificationError: text("notification_error"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outgoingEmails = pgTable("outgoing_emails", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
  sourceMessageId: bigint("source_message_id", { mode: "bigint" }).notNull(),
  recipientEmail: text("recipient_email").notNull(),
  recipientName: text("recipient_name"),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  status: text("status")
    .notNull()
    .$type<"pending_confirm" | "sent" | "cancelled" | "failed">(),
  pendingTelegramMessageId: bigint("pending_telegram_message_id", { mode: "bigint" }),
  gmailSentMessageId: text("gmail_sent_message_id"),
  gmailThreadId: text("gmail_thread_id"),
  sendErrorText: text("send_error_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const pendingConflictDecisions = pgTable("pending_conflict_decisions", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }).notNull(),
  newEventSpec: jsonb("new_event_spec").notNull(),
  conflictEventGcalId: text("conflict_event_gcal_id").notNull(),
  conflictEventSummary: text("conflict_event_summary").notNull(),
  conflictEventStartAt: timestamp("conflict_event_start_at", { withTimezone: true }).notNull(),
  conflictEventEndAt: timestamp("conflict_event_end_at", { withTimezone: true }).notNull(),
  conflictEventEtag: text("conflict_event_etag"),
  conflictEventAllDay: boolean("conflict_event_all_day").notNull().default(false),
  state: text("state").notNull().$type<"awaiting_button" | "awaiting_new_time">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const pendingEventEdits = pgTable("pending_event_edits", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }).notNull(),
  kind: text("kind").notNull().$type<"modify" | "cancel">(),
  targetEventId: text("target_event_id"),
  candidatesJson: jsonb("candidates_json"),
  newStartAt: timestamp("new_start_at", { withTimezone: true }),
  newEndAt: timestamp("new_end_at", { withTimezone: true }),
  newTitle: text("new_title"),
  newLocation: text("new_location"),
  state: text("state").notNull().$type<"awaiting_pick" | "awaiting_button">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  entityType: text("entity_type")
    .notNull()
    .$type<
      "calendar_event" | "outgoing_email" | "processed_email" | "pending_decision" | "system"
    >(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  actor: text("actor")
    .notNull()
    .$type<"detector" | "user_text" | "user_callback" | "system_cron" | "recovery">(),
  chatId: bigint("chat_id", { mode: "bigint" }),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  reason: text("reason"),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const systemKv = pgTable("system_kv", {
  key: text("key").primaryKey(),
  valueText: text("value_text"),
  valueJson: jsonb("value_json"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
export type ProcessedEmail = typeof processedEmails.$inferSelect;
export type NewProcessedEmail = typeof processedEmails.$inferInsert;
export type OutgoingEmail = typeof outgoingEmails.$inferSelect;
export type NewOutgoingEmail = typeof outgoingEmails.$inferInsert;
export type PendingConflictDecision = typeof pendingConflictDecisions.$inferSelect;
export type NewPendingConflictDecision = typeof pendingConflictDecisions.$inferInsert;
export type PendingEventEdit = typeof pendingEventEdits.$inferSelect;
export type NewPendingEventEdit = typeof pendingEventEdits.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type SystemKv = typeof systemKv.$inferSelect;
export type NewSystemKv = typeof systemKv.$inferInsert;

// Silence drizzle "unused import" — references used by tooling, keep import.
void index;
void uniqueIndex;
