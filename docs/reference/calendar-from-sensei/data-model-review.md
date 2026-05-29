# feat-12b — критический ревью модели данных (calendar_events)

> Запущен независимый Opus-reviewer (fresh context) 2026-05-28 по правилу `~/CLAUDE.md`
> «Reviewer перед моделями данных». Ниже — принятые решения.

## Вердикт

Черновик `calendar_events` из scope-and-decisions.md — недоспроектирован под уже зафиксированные
12c (изменение/отмена событий) и 12d (опрос после события). Принято 10 доработок.

## Принятые изменения относительно черновика

| # | Изменение | Обоснование |
|---|---|---|
| 1 | Новая таблица **`calendar_event_audit`** (append-only, триггеры RAISE FAIL) | 12c переносит события → без истории «было/стало» теряется откат + сигнал ошибки детектора. ДНК проекта (classification_history, node_audit). |
| 2 | **`dedup_key TEXT NOT NULL UNIQUE`** + `event_index` | Идемпотентность детектора при recovery после рестарта (иначе дубль в Google). Multi-event на одно сообщение. |
| 3 | **`status`** расширен на `pending` + **`gcal_event_id` nullable** | Резерв строки до events.insert: INSERT pending → Google → UPDATE active. Без pending дедупликация невозможна. |
| 4 | **`timezone TEXT NOT NULL DEFAULT 'Europe/Minsk'`** | Дом инварианту timezone_minsk_default. Для all-day пояс иначе теряется. |
| 5 | **`created_by`** CHECK(detector/user_telegram/user_web) | Provenance: отделить автособытия (12b) от ручных (12c). Эвал детектора. |
| 6 | **`detector_confidence REAL`** | Порог + эвал по аналогии с classified_messages.confidence. |
| 7 | **`source_phrase TEXT`** | Кнопка [Оригинальный] + fuzzy-match для 12c при multi-event. |
| 8 | **`gcal_etag TEXT`** | Безопасный events.patch в 12c (optimistic lock — пользователь правит календарь руками). |
| 9 | CHECK формата дат (all_day=10 симв / timed LIKE %T%) + **CHECK(end_iso > start_iso)** | Механизм вместо надежды на детектор. Эксклюзивный конец — явное требование пользователя. |
| 10 | soft delete (status=cancelled, не DELETE) + индекс `idx_ce_end_active` | FK из 12d требует стабильный id; cron 12d «события за час». |

## Отклонено / не делаем

- Отдельная таблица occurrences для multi-event — overkill (1:N через FK уже есть).
- Прямой FK `calendar_events.task_id` — «физически нерелизуемая связь» (правило UX-vs-модель). Связь транзитивно через `classified_message_id`.
- `event_reflections` (12d) — не в 12b, отложено.

## Инварианты → перенести в domain-rules.yaml с механизмом

- `calendar_event_audit_trail` → таблица + триггеры (enforce БД).
- `calendar_event_traceable` → classified_message_id NOT NULL + FK (enforce БД).
- `timezone_minsk_default` → DEFAULT в схеме.
- `no_silent_calendar_creation` → discipline-rule воркера (в БД не выражается, integration smoke).

## Порядок создания события (idempotent recovery)

1. detector решил «есть событие» → формирует dedup_key.
2. INSERT calendar_events status='pending' (резерв dedup_key) ДО Google.
3. events.insert в Google.
4. UPDATE: gcal_event_id, gcal_etag, raw_gcal_response_json, status='active'.

Recovery после рестарта: строки status='pending' без gcal_event_id = «начали, не подтвердили» → дочистить.
