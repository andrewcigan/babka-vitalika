# Контракт webhook: бот ↔ n8n workflow BabkaVitalika

> Зафиксировано 2026-05-29. Версия V1. Этот документ — единственный источник правды
> для feat-001 (n8n workflow) и feat-004 (HTTP-клиент бота). Изменения только через PR
> с обновлением и реализации, и контракта одновременно.

## 1. Транспорт

- **Метод:** HTTP POST
- **URL:** `https://techconstruction.app.n8n.cloud/webhook/babka-vitalika`
  (точный path задаст Webhook-нода при сборке feat-001)
- **Content-Type:** `application/json; charset=utf-8`
- **Аутентификация:** заголовок `X-Webhook-Secret: <SHARED_SECRET>`. Один shared-secret
  для всех action. В n8n Webhook-ноде включён Header Auth с этой шапкой.
  Секрет — длинная случайная строка (≥32 символа). Хранится:
  - на стороне бота: env var `N8N_WEBHOOK_SECRET` (Railway secrets)
  - на стороне n8n: credential типа Header Auth, привязан к Webhook-ноде
- **Timeout:** клиент ставит 60 сек (n8n Cloud Soft Limit). Бот при >60 сек квалифицирует
  как retryable error.

## 2. Общий формат запроса

```json
{
  "action": "<dotted.action.name>",
  "idempotency_key": "<UUID, формируется ботом>",
  "payload": { /* специфично для action */ }
}
```

- `action` — строка из списка ниже.
- `idempotency_key` — UUID, бот сохраняет рядом с операцией. При retry — тот же ключ.
  n8n не использует, но клиент-сторона может игнорировать дубль ответа.
- `payload` — словарь полей под action.

## 3. Общий формат ответа

**Успех (HTTP 200):**
```json
{
  "ok": true,
  "action": "<echo>",
  "idempotency_key": "<echo>",
  "data": { /* специфично для action */ }
}
```

**Ошибка (HTTP 200 с `ok:false`, или 4xx/5xx):**
```json
{
  "ok": false,
  "action": "<echo>",
  "idempotency_key": "<echo>",
  "error": {
    "code": "google_unauthorized | google_not_found | invalid_payload | internal",
    "message": "<human-readable>",
    "details": { /* опционально */ }
  }
}
```

Принцип: **n8n не интерпретирует ошибки**, он возвращает то, что вернул Google API, плюс
свою категоризацию по коду статуса (401 → `google_unauthorized`, 404 → `google_not_found`,
4xx → `invalid_payload`, прочее → `internal`).

## 4. Эндпоинты по action

### 4.1 `calendar.createEvent`

Создать событие в Google Calendar пользователя.

**Request:**
```json
{
  "action": "calendar.createEvent",
  "idempotency_key": "01HX...",
  "payload": {
    "calendar_id": "primary",
    "summary": "Coffee with Sarah",
    "description": "Source: Telegram message id=12345",
    "location": "Blue Bottle, 5th Ave",
    "start": { "dateTime": "2026-06-03T15:00:00", "timeZone": "America/New_York" },
    "end":   { "dateTime": "2026-06-03T16:00:00", "timeZone": "America/New_York" },
    "all_day": false
  }
}
```

Для **all-day** события: `all_day: true`, и `start.date` / `end.date` в формате `YYYY-MM-DD`
(без `dateTime`/`timeZone`); `end.date` — следующий день после последнего дня (Google convention).

**Response (success):**
```json
{
  "ok": true,
  "data": {
    "gcal_event_id": "abc123def456",
    "gcal_etag": "\"3411234567890000\"",
    "html_link": "https://calendar.google.com/event?eid=...",
    "start": { "dateTime": "2026-06-03T15:00:00-04:00" },
    "end":   { "dateTime": "2026-06-03T16:00:00-04:00" }
  }
}
```

### 4.2 `calendar.modifyEvent`

Изменить время/название/локацию существующего события. Все поля в `changes` опциональны.

**Request:**
```json
{
  "action": "calendar.modifyEvent",
  "idempotency_key": "...",
  "payload": {
    "calendar_id": "primary",
    "gcal_event_id": "abc123def456",
    "etag": "\"3411234567890000\"",
    "changes": {
      "start": { "dateTime": "2026-06-03T16:00:00", "timeZone": "America/New_York" },
      "end":   { "dateTime": "2026-06-03T17:00:00", "timeZone": "America/New_York" },
      "summary": "Coffee with Sarah (moved)",
      "location": "Cafe Reggio"
    }
  }
}
```

`etag` — для опциональной защиты от race condition. Если опущен, шлём без `If-Match`.

**Response (success):** аналогично `createEvent` с новыми `gcal_etag` и временами.

### 4.3 `calendar.cancelEvent`

Удалить событие (мягкая отмена через `events.delete`; Google переводит в trash).

**Request:**
```json
{
  "action": "calendar.cancelEvent",
  "idempotency_key": "...",
  "payload": {
    "calendar_id": "primary",
    "gcal_event_id": "abc123def456"
  }
}
```

**Response (success):**
```json
{ "ok": true, "data": { "gcal_event_id": "abc123def456", "status": "cancelled" } }
```

**Идемпотентность:** если событие уже удалено (Google 404/410), n8n возвращает `ok:true`
с `data.status: "already_cancelled"`.

### 4.4 `calendar.listEvents`

Получить события в диапазоне (для конфликт-чека и для fuzzy-матчера при правке).

**Request:**
```json
{
  "action": "calendar.listEvents",
  "idempotency_key": "...",
  "payload": {
    "calendar_id": "primary",
    "time_min": "2026-06-03T00:00:00-04:00",
    "time_max": "2026-06-03T23:59:59-04:00",
    "max_results": 100,
    "single_events": true,
    "order_by": "startTime"
  }
}
```

**Response (success):**
```json
{
  "ok": true,
  "data": {
    "events": [
      {
        "gcal_event_id": "...",
        "summary": "Standup",
        "start": { "dateTime": "2026-06-03T10:00:00-04:00" },
        "end":   { "dateTime": "2026-06-03T10:30:00-04:00" },
        "all_day": false,
        "html_link": "..."
      }
    ],
    "next_page_token": null
  }
}
```

### 4.5 `gmail.listNew`

Получить список новых входящих писем после метки времени (для cron-опроса каждые 15 мин).

**Request:**
```json
{
  "action": "gmail.listNew",
  "idempotency_key": "...",
  "payload": {
    "after_epoch_seconds": 1717392000,
    "label_ids": ["INBOX"],
    "max_results": 50
  }
}
```

`after_epoch_seconds` бот хранит на своей стороне (`last_polled_at`) и передаёт.

**Response (success):**
```json
{
  "ok": true,
  "data": {
    "messages": [
      {
        "gmail_message_id": "18e1abc...",
        "thread_id": "18e1abc...",
        "from": "Sarah <sarah@example.com>",
        "subject": "Re: meeting tomorrow",
        "snippet": "Sounds great, see you at...",
        "received_epoch_seconds": 1717400000
      }
    ],
    "next_page_token": null
  }
}
```

`snippet` — короткий preview от Gmail (≤200 символов). Полное тело — отдельный вызов
`gmail.getMessage` (чтобы не тащить лишний трафик, если письмо потом отфильтруется).

### 4.6 `gmail.getMessage`

Получить полное тело письма для выжимки.

**Request:**
```json
{
  "action": "gmail.getMessage",
  "idempotency_key": "...",
  "payload": {
    "gmail_message_id": "18e1abc...",
    "format": "full"
  }
}
```

**Response (success):**
```json
{
  "ok": true,
  "data": {
    "gmail_message_id": "18e1abc...",
    "from": "Sarah <sarah@example.com>",
    "to": ["client@example.com"],
    "subject": "Re: meeting tomorrow",
    "body_text": "Hi! ...",
    "body_html": "<html>...</html>",
    "received_epoch_seconds": 1717400000
  }
}
```

Бот использует `body_text` для LLM-выжимки. `body_html` — fallback, если plain отсутствует.

## 5. Коды ошибок

| `error.code` | HTTP | Когда | Действие бота |
|---|---|---|---|
| `google_unauthorized` | 401 | OAuth токен Mari протух | Alarm админу в Telegram, прекратить retry до восстановления |
| `google_not_found` | 200 (для delete) или 404 | Событие/письмо уже нет | Считать success (для cancel), update БД (для get) |
| `google_rate_limit` | 429 | Превышена квота | Exponential backoff, retry до 5 раз |
| `invalid_payload` | 400 | Бот прислал кривой JSON | Лог + alarm, не retry |
| `internal` | 500 | n8n упал / непонятная ошибка | Retry до 3 раз с jitter, потом alarm |

## 6. Retry-стратегия (на стороне бота)

- Сетевая ошибка / 5xx / timeout: 3 ретрая, экспоненциальный backoff 2/4/8 сек.
- 401: НЕ retry, alarm.
- 429: до 5 ретраев, backoff 5/15/30/60/120 сек.
- 4xx прочее: НЕ retry, лог + alarm.

Все retry используют **тот же `idempotency_key`** — это важно для будущего: если n8n начнёт
кешировать ответы по ключу, retry будет получать сохранённый ответ, а не дёргать Google
второй раз.

## 7. Версионирование контракта

Поле `action` неявно версионируется через расширение списка. Изменение существующего
эндпоинта без обратной совместимости — новое имя (`calendar.createEvent.v2`).

Контракт V1 зафиксирован 2026-05-29. Любое расширение — обновляет этот документ и
параллельно правит код в feat-001/feat-004.

## 8. Что НЕ в этом контракте

- Логика понимания текста («перенеси на завтра» → структурированная команда). Это **внутри
  бота**, не в n8n.
- Карточки в Telegram, кнопки [Yes]/[Cancel]. Это **внутри бота**.
- LLM-выжимки писем. Это **внутри бота** (Haiku через OpenRouter, не через n8n).
- БД Postgres. n8n про неё не знает, она только у бота.
