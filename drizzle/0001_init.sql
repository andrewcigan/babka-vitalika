-- feat-005 initial schema — БД из 8 таблиц.
-- Канонический спек: docs/features/feat-005/data-model-review.md
-- Не менять руками — для новых полей создавай новую миграцию.

-- ============================================================
-- conversation_messages — память диалога (50 последних на chat_id)
-- ============================================================
CREATE TABLE conversation_messages (
  id                       BIGSERIAL PRIMARY KEY,
  chat_id                  BIGINT NOT NULL,
  telegram_message_id      BIGINT NULL,
  role                     TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  input_kind               TEXT NOT NULL CHECK (input_kind IN ('text', 'voice', 'callback', 'command')),
  content_text             TEXT NOT NULL,
  voice_transcript_raw     TEXT NULL,
  telegram_voice_file_id   TEXT NULL,
  llm_metadata_json        JSONB NULL,
  is_archived              BOOL NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_conversation_msg ON conversation_messages (chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
CREATE INDEX idx_conversation_chat_time ON conversation_messages (chat_id, created_at DESC);

-- ============================================================
-- calendar_events — зеркало событий Google
-- ============================================================
CREATE TABLE calendar_events (
  id                       TEXT PRIMARY KEY,
  dedup_key                TEXT NOT NULL UNIQUE,
  source_message_id        BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  source_chat_id           BIGINT NOT NULL,
  gcal_event_id            TEXT NULL,
  gcal_etag                TEXT NULL,
  gcal_calendar_id         TEXT NOT NULL DEFAULT 'primary',
  title                    TEXT NOT NULL,
  source_phrase            TEXT NULL,
  description              TEXT NULL,
  location                 TEXT NULL,
  all_day                  BOOL NOT NULL,
  start_at                 TIMESTAMPTZ NULL,
  end_at                   TIMESTAMPTZ NULL,
  start_date               DATE NULL,
  end_date                 DATE NULL,
  timezone                 TEXT NOT NULL DEFAULT 'America/New_York',
  created_by               TEXT NOT NULL CHECK (created_by IN (
    'detector_text', 'detector_voice', 'user_callback', 'reschedule_followup', 'recovery'
  )),
  status                   TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'superseded')),
  detector_confidence      REAL NULL,
  raw_gcal_response_json   JSONB NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at                TIMESTAMPTZ NULL,
  CONSTRAINT timing_shape CHECK (
    (all_day = false AND start_at IS NOT NULL AND end_at IS NOT NULL
     AND start_date IS NULL AND end_date IS NULL)
    OR
    (all_day = true AND start_date IS NOT NULL AND end_date IS NOT NULL
     AND start_at IS NULL AND end_at IS NULL)
  ),
  CONSTRAINT timing_order CHECK (
    (all_day = false AND end_at > start_at)
    OR
    (all_day = true AND end_date > start_date)
  )
);
CREATE UNIQUE INDEX uq_gcal_event ON calendar_events (gcal_event_id) WHERE gcal_event_id IS NOT NULL;
CREATE INDEX idx_ce_status_time_timed ON calendar_events (status, start_at) WHERE all_day = false;
CREATE INDEX idx_ce_status_time_allday ON calendar_events (status, start_date) WHERE all_day = true;
CREATE INDEX idx_ce_source_msg ON calendar_events (source_message_id);

-- ============================================================
-- processed_emails — выжимки + уведомления о входящих
-- ============================================================
CREATE TABLE processed_emails (
  gmail_message_id          TEXT PRIMARY KEY,
  thread_id                 TEXT NOT NULL,
  from_email                TEXT NOT NULL,
  from_name                 TEXT NULL,
  subject                   TEXT NULL,
  received_at               TIMESTAMPTZ NOT NULL,
  summary_text              TEXT NOT NULL,
  summary_action_items_json JSONB NULL,
  summary_urgency           TEXT NULL CHECK (summary_urgency IN ('high', 'medium', 'low')),
  summary_llm_metadata_json JSONB NULL,
  notification_chat_id      BIGINT NOT NULL,
  notification_telegram_message_id  BIGINT NULL,
  notification_status       TEXT NOT NULL CHECK (notification_status IN ('pending', 'sent', 'failed')),
  notification_error        TEXT NULL,
  notified_at               TIMESTAMPTZ NULL,
  inserted_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pe_received ON processed_emails (received_at DESC);
CREATE INDEX idx_pe_pending ON processed_emails (notification_status) WHERE notification_status = 'pending';

-- ============================================================
-- outgoing_emails — отправленные / pending-confirm
-- ============================================================
CREATE TABLE outgoing_emails (
  id                       BIGSERIAL PRIMARY KEY,
  chat_id                  BIGINT NOT NULL,
  source_message_id        BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  recipient_email          TEXT NOT NULL,
  recipient_name           TEXT NULL,
  subject                  TEXT NOT NULL,
  body_text                TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('pending_confirm', 'sent', 'cancelled', 'failed')),
  pending_telegram_message_id  BIGINT NULL,
  gmail_sent_message_id    TEXT NULL,
  gmail_thread_id          TEXT NULL,
  send_error_text          TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ NULL,
  expires_at               TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_oe_status ON outgoing_emails (status, expires_at);

-- ============================================================
-- pending_conflict_decisions — 4-кнопочная карточка конфликта
-- ============================================================
CREATE TABLE pending_conflict_decisions (
  id                         BIGSERIAL PRIMARY KEY,
  chat_id                    BIGINT NOT NULL,
  telegram_message_id        BIGINT NOT NULL,
  new_event_spec             JSONB NOT NULL,
  conflict_event_gcal_id     TEXT NOT NULL,
  conflict_event_summary     TEXT NOT NULL,
  conflict_event_start_at    TIMESTAMPTZ NOT NULL,
  conflict_event_end_at      TIMESTAMPTZ NOT NULL,
  conflict_event_etag        TEXT NULL,
  conflict_event_all_day     BOOL NOT NULL DEFAULT false,
  state                      TEXT NOT NULL CHECK (state IN ('awaiting_button', 'awaiting_new_time')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                 TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_pcd_chat_state ON pending_conflict_decisions (chat_id, state);
CREATE INDEX idx_pcd_expires ON pending_conflict_decisions (expires_at);

-- ============================================================
-- pending_event_edits — confirm-карточка modify/cancel
-- ============================================================
CREATE TABLE pending_event_edits (
  id                       BIGSERIAL PRIMARY KEY,
  chat_id                  BIGINT NOT NULL,
  telegram_message_id      BIGINT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('modify', 'cancel')),
  target_event_id          TEXT NULL REFERENCES calendar_events(id),
  candidates_json          JSONB NULL,
  new_start_at             TIMESTAMPTZ NULL,
  new_end_at               TIMESTAMPTZ NULL,
  new_title                TEXT NULL,
  new_location             TEXT NULL,
  state                    TEXT NOT NULL CHECK (state IN ('awaiting_pick', 'awaiting_button')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_pee_chat_state ON pending_event_edits (chat_id, state);
CREATE INDEX idx_pee_expires ON pending_event_edits (expires_at);

-- ============================================================
-- audit_log — append-only журнал (REJECT UPDATE/DELETE)
-- ============================================================
CREATE TABLE audit_log (
  id                       BIGSERIAL PRIMARY KEY,
  entity_type              TEXT NOT NULL CHECK (entity_type IN (
    'calendar_event', 'outgoing_email', 'processed_email', 'pending_decision', 'system'
  )),
  entity_id                TEXT NOT NULL,
  action                   TEXT NOT NULL,
  actor                    TEXT NOT NULL CHECK (actor IN (
    'detector', 'user_text', 'user_callback', 'system_cron', 'recovery'
  )),
  chat_id                  BIGINT NULL,
  before_json              JSONB NULL,
  after_json               JSONB NULL,
  reason                   TEXT NULL,
  performed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, performed_at DESC);
CREATE INDEX idx_audit_chat_time ON audit_log (chat_id, performed_at DESC) WHERE chat_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ============================================================
-- system_kv — служебное состояние (last_polled_at и т.п.)
-- ============================================================
CREATE TABLE system_kv (
  key                      TEXT PRIMARY KEY,
  value_text               TEXT NULL,
  value_json               JSONB NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- updated_at trigger (общий helper)
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ce_updated_at BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_skv_updated_at BEFORE UPDATE ON system_kv
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
