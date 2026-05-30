# feat-005 — критический ревью модели данных Postgres

> Запущен независимый Opus-reviewer (fresh context) 2026-05-30 по обязательному
> глобальному правилу `~/CLAUDE.md` («Reviewer перед моделями данных»). Цель —
> поймать пропуски, лишние сущности, anti-patterns и спорные развилки **до**
> реализации feat-005.
>
> Источники, прочитанные ревьюером:
> - `AGENTS.md`, `domain-rules.yaml` (особенно `invariants`)
> - `feature_list.json` (все фичи в `up_next` / `captured` / `done`)
> - `docs/ARCHITECTURE.md` (треугольник + 6 actions)
> - `docs/n8n-workflow-contract.md` (что есть на webhook-стороне)
> - `docs/reference/calendar-from-sensei/HANDOFF.md` (рабочая референс-реализация)
> - `docs/reference/calendar-from-sensei/data-model-review.md` (прошлый Opus-review)
> - `src/bot.ts`, `src/n8n-client.ts` (что бот уже делает сейчас)
>
> Тон ревью — критический. Если что-то выглядит ОК — так и сказано. Если есть
> сомнение — оно прямое.

---

## TL;DR — пять вещей, которые надо обязательно поправить до старта

1. **`dedup_key = <message_id>:<start_iso>` ломается на пайплайне**. `start_iso` меняется
   между «detector извлёк» и «фактическим insert» (округление, clarification, conflict).
   Использовать `<chat_id>:<telegram_message_id>:<event_seq>` где `event_seq` — порядковый
   номер события внутри сообщения (для multi-event). Это совпадает с подходом Sensei-tsy
   и устойчиво к изменениям времени.

2. **Пропущена сущность `sent_emails`**. `pending_outgoing_emails` хранит только pending,
   а после клика [Send] — событие **не сохраняется как первоклассный объект**. Audit-log не
   заменяет это: бизнес-сценарий «покажи письма, которые я отправил» не выражается. Сделать
   `outgoing_emails` со статусами `pending` → `sent` → `failed`, плюс gmail-id отправленного.

3. **Пропущена сущность `system_kv` (last_polled_at и т.п.)**. Cron Gmail-опроса хранит
   timestamp последнего успешного опроса. Без таблицы — после рестарта Railway либо потеряем
   письма, либо пере-обработаем (дубль-уведомлений ловит UNIQUE, но это запасная защита, а
   не основная). В схеме нет ничего, что хранило бы это.

4. **`conversation_messages` слишком тонкая для voice + intent + diagnostic**. Не хватает:
   `telegram_message_id`, `input_kind` (text/voice/callback), `voice_transcript_raw`,
   `llm_metadata_json` (модель/токены/латентность). Без этого нельзя отлаживать halucinations
   Whisper и анализировать стоимость per-message.

5. **«Reschedule old» сценарий держится на честном слове**. `pending_conflict_decisions.state
   = 'awaiting_new_time'` есть, но **в схеме не хранится duration старого события** для
   корректного relativize («перенеси на 4pm» → сохранить длительность 1 час). Плюс открыт
   вопрос: что делает бот, если в режиме `awaiting_new_time` пользователь пишет «как дела?» —
   нужен dismissal-mechanism (LLM-проверка «это время?» или таймаут).

Все детали — ниже.

---

## ⚠️ Критические пропуски (обязательно поправить до feat-005)

### 1. `dedup_key` нестабилен по дизайну

**Проблема.** Предложено `dedup_key = <conversation_message_id>:<start_iso>`. Жизненный
цикл события (наследие Sensei-tsy):

1. Detector извлёк events[] — `start_iso` — это **сырая интерпретация LLM** («tomorrow at 3pm» → `2026-05-31T15:00:00`).
2. Бот **до** Google-вставки делает `INSERT calendar_events status='pending'` с этим `dedup_key`.
3. Conflict check, возможный пользовательский [Reschedule new] изменяет `start_iso`.
4. После принятия — Google insert, `UPDATE status='active'`.

Между шагами 2 и 4 `start_iso` может измениться (округление до ближайших 15 мин, clarification
от пользователя, конфликт-резолв). Если меняется до шага 2 — `dedup_key` другой → INSERT
проходит, дубль в Google **не создаётся** (потому что Google-инсерт ещё не было). Но если
меняется ПОСЛЕ pending insert — нужно делать UPDATE dedup_key, что нарушает идею
«дедуп-ключ — immutable identity».

Хуже: при recovery после рестарта (бот упал между pending insert и Google insert) — пересчёт
`start_iso` после LLM-вызова может дать другой результат → recovery не увидит pending-запись
→ создаст дубль.

**Решение.** `dedup_key = <chat_id>:<telegram_message_id>:<event_seq>` где `event_seq` —
порядковый номер события внутри LLM-вывода (0, 1, 2…). Это:
- **Immutable** относительно изменений времени.
- Соответствует подходу Sensei-tsy (но строже — добавляем `chat_id` чтобы убрать риск
  столкновения message_id из разных чатов, если whitelist расширится).
- Поддерживает multi-event на одно сообщение (разные `event_seq`).

Sensei-tsy использовал `<message_id>:<start_iso>` (см. `HANDOFF.md` § 5.1), это была
тонкая ошибка которую тогда не поймали — но Sensei-tsy был single-user single-chat и
multi-event редко случается.

**Действие.**
```
dedup_key TEXT NOT NULL UNIQUE
-- format: '<chat_id>:<telegram_message_id>:<event_seq>'
-- event_seq = ordinal index in detector.events[] output (0-based)
```

### 2. Пропущена сущность `sent_emails`

**Проблема.** Бизнес-сценарий 5 («отправка письма») реализуется так:
- AI извлекает recipient/subject/body → `pending_outgoing_emails`
- Клик [Send] → `gmail.sendMessage` через n8n → **что дальше?**

В предложенной схеме — **ничего**. Запись из `pending_outgoing_emails` либо удаляется
(потеряли историю что вообще отправляли), либо остаётся с `state='sent'` (но тогда
название «pending» врёт). Audit-log с `entity_type='outgoing_email'` ловит факт отправки,
но это **не первоклассный объект для запроса** — нельзя сделать «покажи мои письма за
неделю» эффективным SQL без джойнов в JSONB.

Это ровно тот класс ошибки, который Sensei-tsy reviewer ловил: «использовать audit как
основное хранилище — анти-паттерн, audit для диффов, не для бизнес-данных».

**Решение.** Сделать `outgoing_emails` отдельной first-class таблицей:

```sql
outgoing_emails
  id                  BIGSERIAL PK
  chat_id             BIGINT NOT NULL
  source_message_id   BIGINT NOT NULL REFERENCES conversation_messages(id)
  recipient_email     TEXT NOT NULL
  recipient_name      TEXT
  subject             TEXT NOT NULL
  body_text           TEXT NOT NULL
  status              TEXT NOT NULL CHECK (status IN ('pending_confirm', 'sent', 'cancelled', 'failed'))
  pending_telegram_message_id BIGINT  -- card message id, NULL после resolve
  gmail_sent_message_id TEXT  -- ID отправленного письма в Gmail (заполняется после send)
  gmail_thread_id     TEXT
  send_error_text     TEXT  -- если status='failed'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  resolved_at         TIMESTAMPTZ  -- момент клика [Send]/[Cancel]
  expires_at          TIMESTAMPTZ  -- для auto-cancel неотвеченных карточек
```

Тогда `pending_outgoing_emails` как отдельная таблица — **не нужна** (она поглощается этой,
status='pending_confirm' играет роль pending). Это упрощает схему: -1 таблица.

**Дополнительно**: invariant `mail_send_requires_confirm_card` теперь enforce через
CHECK: нельзя insert со status='sent' без предыдущего перехода через 'pending_confirm'
(audit-log проверяет). На уровне БД проще: запретить INSERT со status='sent' (триггер
требует UPDATE из 'pending_confirm').

### 3. Пропущена сущность `system_kv` (last_polled_at и friends)

**Проблема.** Email polling cron должен помнить **timestamp последнего успешного опроса**
чтобы передавать его в `gmail.listNew` (см. `n8n-workflow-contract.md` § 4.5
`after_epoch_seconds`). В предложенной схеме нет ни одной таблицы для этого.

Альтернативы:
- Env-var → переживает рестарт **только если** не перезаписываем при каждом опросе. Нельзя
  обновлять через env. Откидываем.
- Hardcode «опрашиваем последние 30 мин» → перекрытие окон, защита через
  UNIQUE(gmail_message_id) — работает, но костыль (зачем дёргать Gmail на старые письма?).
- **Persistent table** — правильный путь.

**Решение.** Минимальная KV-таблица для системного состояния:

```sql
system_kv
  key         TEXT PK
  value_text  TEXT
  value_json  JSONB
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

Ключи MVP:
- `gmail.last_polled_at_epoch` → текст с epoch seconds
- `gmail.last_processed_at_epoch` → отдельный (poll != processed; могут быть processing errors)
- `calendar.last_pending_recovery_at` → диагностика recovery

Это лучше отдельной `gmail_poll_state` таблицы — экономия одной таблицы, расширяемо без
миграций для будущих фич (например `gmail.watch_subscription_expiry` при переходе на push).

**Альтернатива**: отдельные узкие таблицы (`gmail_poll_state`, и т.п.). Минус — больше DDL
суеты. Для MVP KV проще и не теряет ничего важного.

### 4. `conversation_messages` слишком тонкая

**Проблема.** Предложено:
```
conversation_messages (id, chat_id, role, content_text, created_at)
```

Чего не хватает критично:

a) **`telegram_message_id BIGINT`** — без него нельзя:
   - линковать события календаря на конкретное Telegram-сообщение для UI «событие из этого
     текста» (кнопка [Show original]).
   - dedup_key события на `telegram_message_id` (см. пункт 1 выше).
   - реагировать на edit пользовательского сообщения в Telegram (продвинутая фича, но
     закладываем поле сейчас, чтобы не мигрировать).

b) **`input_kind TEXT NOT NULL CHECK (input_kind IN ('text', 'voice', 'callback'))`** —
   нужно для:
   - аналитики «сколько процентов через voice»
   - различения сообщения-команды от ответа-на-кнопку (`callback`). Сейчас непонятно куда
     писать строку «user clicked [Send]» — в `conversation_messages` или нигде.
   - инвариант `voice_input_via_whisper_api` enforce: если `input_kind='voice'`, поле
     `voice_transcript_raw` должно быть NOT NULL.

c) **`voice_transcript_raw TEXT NULL`** — оригинальный текст от Whisper до фильтрации
   галлюцинаций. Нужно для отладки (HANDOFF.md § 13.5 — известные грабли «Спасибо за
   просмотр»). Без сырого текста невозможно понять «бот ошибся или Whisper выдал бред».

d) **`telegram_voice_file_id TEXT NULL`** — Telegram file_id для повторного скачивания
   голосового, если нужно перепроверить (диагностика отдельных кейсов). Telegram держит
   file бесконечно по file_id.

e) **`llm_metadata_json JSONB NULL`** — для bot-сообщений: модель, input_tokens,
   output_tokens, latency_ms, cost_usd. Без этого нельзя посчитать стоимость per-feature
   и невозможно соблюсти `cost_policy.per_feature_budget_usd = $5`.

f) **Composite UNIQUE (chat_id, telegram_message_id)** — Telegram гарантирует уникальность
   message_id в пределах chat, у нас это становится естественным natural key.

**Решение.**

```sql
conversation_messages
  id                      BIGSERIAL PK
  chat_id                 BIGINT NOT NULL
  telegram_message_id     BIGINT NULL  -- NULL для bot-сообщений, отправленных через API
  role                    TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system'))
  input_kind              TEXT NOT NULL CHECK (input_kind IN ('text', 'voice', 'callback', 'command'))
  content_text            TEXT NOT NULL  -- финальный текст (для voice — после фильтра halucinations)
  voice_transcript_raw    TEXT NULL      -- только если input_kind='voice', сырой Whisper-output
  telegram_voice_file_id  TEXT NULL      -- для re-download при отладке
  llm_metadata_json       JSONB NULL     -- для assistant: model, tokens, latency, cost
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE (chat_id, telegram_message_id) WHERE telegram_message_id IS NOT NULL
INDEX (chat_id, created_at DESC)  -- для "последние 50"
```

**Замечание про инвариант `memory_in_postgres`**: «окно 50 последних обменов» — `pair`,
т.е. 50 user+50 assistant = 100 строк? Или 50 строк всего? Из домен-rules неясно.
**Зафиксировать однозначно**. Рекомендация: 50 user-messages + связанные ответы (joined
on time proximity) — это совпадает с тем, как Sonnet видит контекст.

### 5. `pending_conflict_decisions` — недостаточно полей для Reschedule old

**Проблема.** Сценарий: пользователь хочет создать «meeting at 3pm», конфликт со встречей
«Standup at 2:30-3:30». Кликает [🔄 Reschedule old]. Бот шлёт «reply with new time for
Standup». Пользователь пишет «4pm».

Что бот должен сделать:
1. Запатчить старое (Standup) → новое время 4pm с **сохранением длительности** (4:00-5:00,
   не 4:00-3:30).
2. Создать новое (meeting at 3pm) в исходное время.

В предложенной схеме:
- `conflict_event_gcal_id` есть → бот может вызвать `calendar.modifyEvent`.
- НО: **не хранится оригинальное `start/end` старого события**. Бот должен либо:
  - повторно вызвать `calendar.getEvent` через n8n (отдельный action которого пока **нет** в
    контракте — см. n8n-workflow-contract.md, только `listEvents`).
  - сохранить при создании pending_conflict_decisions.

**Дополнительная проблема**: state machine. Когда `state='awaiting_new_time'`, что делает
бот если пользователь пишет:
- «4pm» → ок, парсим как время.
- «как дела?» → должен ли intent-router забыть про pending? Молча обработать новое сообщение?
- «отмени» → отменяет режим или ловит на отмену чего-то ещё?

Без явного правила — ловушка для regression-багов.

**Решение.** Добавить поля:

```sql
pending_conflict_decisions
  ...
  conflict_event_start_iso   TIMESTAMPTZ NOT NULL  -- старт старого события (для duration)
  conflict_event_end_iso     TIMESTAMPTZ NOT NULL  -- финиш старого события
  conflict_event_etag        TEXT NULL             -- для безопасного patch
  conflict_event_all_day     BOOL NOT NULL DEFAULT false
  ...
```

И **зафиксировать в `domain-rules.yaml`** правило disambiguation для state-machine:

```yaml
disambiguation_triggers:
  - trigger: "awaiting_new_time_user_input"
    description: "Пользователь в режиме pending_conflict 'awaiting_new_time' прислал текст"
    action: >
      LLM-проверка (Sonnet) "is this a time/date expression?":
      - YES → парсим как новое время для conflict_event, применяем reschedule + create
      - NO → молча abandon pending (логируем), обрабатываем сообщение как обычный intent.
              Опционально шлём "I dropped the reschedule request, ok?"
```

---

## 🟡 Важные замечания (стоит поправить)

### 6. `pending_event_edits.candidates_json` — где FSM по сценарию multiple-match?

**Проблема.** При fuzzy-match нескольких кандидатов:
1. Бот шлёт карточку «which one?» с кнопками-кандидатами.
2. Пользователь кликает кандидата.
3. Что дальше?
   - Применяем сразу? Тогда нет confirmation для modify/cancel — нарушает паттерн
     `Yes/Cancel` (см. invariant — для cancel/modify нужен явный confirm).
   - Или: после pick → обновляем ту же карточку до confirm `[Yes][Cancel]`?

В предложенной схеме `state='awaiting_pick' | 'awaiting_button'` подразумевает второе.
**Это правильно**, но не задокументировано в feat-017 description.

**Действие.** В description feat-017 явно прописать:
> При multiple match → карточка [Pick A][Pick B]…[Cancel]. По pick — карточка
> редактируется в confirm `[Yes][Cancel]`. По [Yes] — apply. Два состояния
> pending_event_edits в одной записи.

### 7. Cleanup pending-таблиц — кто и когда

**Проблема.** Поле `expires_at TIMESTAMPTZ` есть во всех pending-таблицах ✓. Но **никто
не чистит**. Через год Postgres имеет горы протухших pending-записей.

Также: при экспирации — слать «card expired» пользователю или молча? Решение нужно явно.

**Решение.**
- Cron job в боте (раз в час) — `DELETE FROM pending_* WHERE expires_at < now()`.
- TTL: 24 часа default (если карточка не нажата за сутки — фокус на новые дела).
- Молчаливая экспирация в MVP (опционально расширить до «I'm dropping that request, want to
  restart?» если получим обратную связь).
- **Добавить в feature_list.json** маленькую фичу `feat-024` (S) «Pending cleanup cron»
  как зависимость от feat-005.

### 8. Recovery orphan calendar_events

**Проблема.** Сценарий: бот сделал `INSERT calendar_events status='pending'` (резерв
dedup_key) → упал ДО Google insert. После рестарта — строка с `status='pending'` и
`gcal_event_id=NULL`. Что делать?

Sensei-tsy решал это методом `listOrphanedPending` + ручная очистка/повтор (HANDOFF.md
§ 8.3). У нас в плане ничего такого нет.

**Решение.**
- При старте бота — `SELECT * FROM calendar_events WHERE status='pending' AND
  gcal_event_id IS NULL` → для каждой:
  - Если `created_at > now() - 1 минута` → подождать, ещё может проинсёртиться
    параллельно.
  - Иначе → пометить `status='superseded'` с reason `recovery_orphan_cleanup`, audit-row.
- Альтернативно: повторить детектор на исходном сообщении — но это сложнее и может дать
  другой результат (LLM не детерминистичен).

**Действие.** Добавить процедуру в feat-015 description или отдельной мини-фичей `feat-025`
(S).

### 9. `audit_log.entity_id TEXT` — нет FK enforcement

**Проблема.** Универсальная таблица `audit_log` имеет `entity_id TEXT` без FK. Если
календарное событие удалят физически (миграция, чистка) — audit-rows ссылаются на
несуществующее. Поскольку invariant требует soft delete (status='cancelled'), физическое
DELETE не должно происходить — но защиты от случайной чистки на уровне БД нет.

**Решение.** Не делать FK (он усложняет универсальность), но:
- Добавить CHECK `entity_type IN ('calendar_event', 'outgoing_email', 'gmail_received',
  'conversation_message', 'pending_decision')` — fixed enum.
- В каждой бизнес-таблице запретить DELETE триггером (только soft delete через status).
- Index `audit_log (entity_type, entity_id, performed_at DESC)`.

### 10. `processed_emails` — добавить notification metadata

**Проблема.** Текущая схема:
```
processed_emails (gmail_message_id PK, thread_id, received_epoch_seconds, notified_at, summary_text)
```

Не хватает для разумной отладки:
- `notification_telegram_message_id BIGINT NULL` — какой Telegram message содержит push.
- `notification_error TEXT NULL` — если push провалился (Telegram timeout).
- `summary_action_items_json JSONB NULL` — structured action items из описания
  («action items, urgency» — у тебя `summary_text TEXT` плоско, теряем структуру).
- `summary_urgency TEXT NULL CHECK (urgency IN ('high', 'medium', 'low'))`.
- `summary_llm_metadata_json JSONB NULL` — модель/токены/cost.
- `from_email TEXT NULL`, `from_name TEXT NULL`, `subject TEXT NULL` — для запросов «покажи
  что приходило от X». Иначе для этого надо лезть в Gmail API повторно.

**Решение.** Расширить таблицу:

```sql
processed_emails
  gmail_message_id       TEXT PK
  thread_id              TEXT NOT NULL
  from_email             TEXT NOT NULL
  from_name              TEXT NULL
  subject                TEXT NULL
  received_at            TIMESTAMPTZ NOT NULL  -- замена received_epoch_seconds, консистентно
  -- summary
  summary_text           TEXT NOT NULL
  summary_action_items_json  JSONB NULL  -- [{text, due_at?, person?}]
  summary_urgency        TEXT NULL CHECK (summary_urgency IN ('high', 'medium', 'low'))
  summary_llm_metadata_json  JSONB NULL  -- model, tokens, cost
  -- notification
  notification_chat_id   BIGINT NOT NULL
  notification_telegram_message_id  BIGINT NULL  -- NULL если send failed
  notification_status    TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed'))
  notification_error     TEXT NULL
  notified_at            TIMESTAMPTZ NULL
  -- timestamps
  inserted_at            TIMESTAMPTZ NOT NULL DEFAULT now()

INDEX (received_at DESC)
INDEX (notification_status) WHERE notification_status='pending'  -- для retry
```

**Замечание по exactly-once semantics**: «помечаем processed ДО отправки» — твоя стратегия
из feat-018. Это даёт **at-most-once** (если send упал — нет уведомления). Альтернатива:
два шага `pending` → `sent` через outbox-pattern. Для MVP at-most-once ок (Atsyhan
проверит почту глазами раз в день, упущенное письмо не критично). **Зафиксировать как
осознанный выбор** в feat-018 description.

### 11. all-day events — `TIMESTAMPTZ` теряет семантику

**Проблема.** Google для all-day шлёт `start.date = '2026-06-03'` без времени. Если хранить
в `start_iso TIMESTAMPTZ`, нужно конвертировать в `2026-06-03T00:00:00-04:00`. При
конвертации обратно в Google — теряется или приобретается timezone, что для all-day
неестественно.

Также: all-day событие может быть многодневным (отпуск с 5 по 12). Google end_date =
`2026-06-13` (exclusive next day).

**Решение.** Два варианта:

A) **Discriminated columns** (предпочтительно):
```sql
calendar_events
  ...
  all_day        BOOL NOT NULL
  start_at       TIMESTAMPTZ NULL    -- для timed
  end_at         TIMESTAMPTZ NULL    -- для timed
  start_date     DATE NULL           -- для all-day
  end_date       DATE NULL           -- для all-day, exclusive (Google convention)
  ...
CHECK (
  (all_day = false AND start_at IS NOT NULL AND end_at IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
  OR
  (all_day = true AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_at IS NULL AND end_at IS NULL)
)
CHECK ((all_day = false AND end_at > start_at) OR (all_day = true AND end_date > start_date))
```

B) Хранить всё в `start_iso/end_iso TIMESTAMPTZ` с **локальной полуночью**, конвертацию
делать в коде. Минус: можно случайно сравнить timed-событие с all-day-событием в SQL и не
заметить семантическую ошибку.

**Рекомендация: вариант A.** Он явный и СУБД проверяет инвариант.

### 12. `calendar_events.created_by` — расширить enum

**Проблема.** Предложено `'detector' / 'user_telegram'`. Не хватает:
- `'user_callback'` — событие создано через клик [📌 Book anyway] на конфликт-карточке
  (не первичный input, а решение).
- `'recovery'` — восстановление orphan после рестарта.
- `'reschedule_followup'` — событие созданное в составе reschedule-old flow.

**Решение.**
```sql
created_by TEXT NOT NULL CHECK (created_by IN (
  'detector_text',       -- из обычного текстового сообщения
  'detector_voice',      -- из голосового (через Whisper)
  'user_callback',       -- по клику кнопки (Book anyway, etc.)
  'reschedule_followup', -- внутри сценария Reschedule old
  'recovery'             -- restoration после crash
))
```

### 13. Пропущена связь `source_message_id` для повторного создания

**Проблема.** Когда пользователь кликает [📌 Book anyway] — событие создаётся **позже** чем
исходное сообщение пришло. Какой `source_message_id` использовать?

Два варианта:
- Оригинальное сообщение, которое детектор увидел как событие. **Предпочтительно** — это
  настоящий «источник» события (intent был с него).
- Callback-event как `conversation_message` (см. пункт 4b — `input_kind='callback'`),
  ссылка на него.

**Рекомендация.** Оригинальное сообщение, **плюс** в `audit_log` пишем action='create'
с `actor='user_callback'` и `reason='conflict_card_book_anyway'`.

### 14. `conversation_messages` cleanup / retention

**Проблема.** Окно «50 последних» — это для чтения. Но в БД мы храним всё навсегда. За год
работы — миллионы строк (если есть voice transcripts с большим content_text — тб данных).

**Решение.**
- **MVP**: ничего не чистим, мониторим размер. Перфоманс «select last 50 by index» не
  страдает.
- **После MVP**: добавить `feat-026` (S) — `archive_old_conversation_messages` cron: всё
  старше 90 дней → флаг `is_archived=true` (не удалять, чтобы FK calendar_events не сломался).
- **Альтернатива**: использовать Postgres partitioning по месяцам. Overkill для MVP.

**Заметка**: если `calendar_events.source_message_id` имеет ON DELETE RESTRICT (мой
recommendation), физически удалять conversation_messages нельзя — только soft archive.

### 15. Whitelist логирование — где хранить попытки чужих?

**Проблема.** Invariant `whitelist_chat_ids` говорит: «Любой другой chat → молчаливый
ignore (не отвечать, не логировать пользовательский текст — только chat_id с warn)».

«warn в лог» — структурный pino-лог, не БД. **Это правильно для MVP**: одна-две попытки
от посторонних в год — не нужна отдельная таблица. Но **уточнить**: если попыток будет
много (DDoS / случайные боты находят) — Railway logs могут стать дорогими, нужен rate-limit
на бот-уровне до middleware (чтобы Telegram getUpdate не тратил квоту).

**Действие.** Зафиксировать решение «без таблицы» в feat-010 description, добавить заметку
«если жалобы на flood — добавить in-memory rate-limit».

---

## 🟢 Спорные решения (требуют явного выбора и фиксации)

### 16. Универсальный `audit_log` vs `calendar_event_audit` + `email_audit`

**Развилка из вопроса.** Sensei-tsy делал отдельный (`calendar_event_audit`). У нас
предложен универсальный.

**Pros универсального:**
- Одна таблица, одна миграция, один триггер append-only.
- Кросс-сущностные запросы (что произошло с этим chat_id во временном окне) — одной таблицы.
- Меньше количество таблиц (у нас уже ~9 — лимит когнитивной нагрузки).

**Cons универсального:**
- `entity_id TEXT` теряет типизацию (нет FK).
- `before_json/after_json JSONB` без схемы — каждая фича сама себе хозяйка структуры.
- Сложнее эволюция (если для calendar нужны новые поля типа `etag_diff` — добавлять в
  JSONB вместо колонки).

**Pros отдельных:**
- Strong typing (FK на родителя).
- Колонки явные, легко добавлять calendar-специфичные поля без затрагивания email.

**Cons отдельных:**
- N таблиц вместо одной, N миграций, N триггеров.
- Дублирование структуры (action, actor, performed_at — везде).

**Рекомендация.** **Универсальный для MVP**. Аргументы:
- Календарных action и email-action логически похожих типов (create/patch/cancel) — один
  alfabet.
- 9 таблиц уже на грани — еще 3 (`calendar_event_audit`, `email_audit`,
  `outgoing_email_audit`) — перебор.
- JSONB before/after для MVP терпимо, схему диктует код, можно ввести типы в коде.
- **Если станет неудобно** через 3 месяца — мигрировать в отдельные таблицы не сложно.

**Зафиксировать в feat-021 description**: «универсальная таблица, JSONB before/after, типы
дифф'ов на стороне кода, при росте сложности — миграция в отдельные таблицы».

### 17. Pending-таблицы: 3 отдельных vs 1 универсальная

**Развилка из вопроса.** Сейчас 3: `pending_conflict_decisions`, `pending_outgoing_emails`,
`pending_event_edits`.

**Pros 1 универсальной (`pending_user_decisions`):**
- Унификация TTL/cleanup cron — одна таблица.
- Унификация callback dispatch (одно место).
- Меньше таблиц в схеме.

**Cons 1 универсальной:**
- Все типизированные поля становятся JSONB → потеря безопасности.
- Очень разная структура (conflict_event_etag vs recipient_email vs candidates_json) —
  fit в общую схему натяжкой.
- Сложнее CHECK (нельзя проверить «у conflict-карточки есть `conflict_event_etag`»).

**Pros 3 отдельных (текущий план):**
- Strong typing.
- Явные CHECK по каждой.
- Callback handlers явные.

**Cons 3 отдельных:**
- Дублирование (chat_id, telegram_message_id, state, expires_at везде).
- Cleanup cron — 3 запроса вместо одного.

**Рекомендация.** **3 отдельных** (твой текущий план — оставить). Но **с учётом пункта 2**
(outgoing_emails становится full-fledged таблицей с status='pending_confirm'), у нас
остаётся **2 отдельных**: `pending_conflict_decisions` + `pending_event_edits`. Это
приемлемая когнитивная нагрузка. **Дублирование структуры (chat_id, expires_at) терпимо**.

### 18. Whitelist: env-var vs `allowed_chat_ids` table

**Развилка из вопроса.** Сейчас env-var (см. invariant). Предложение — таблица.

**Pros env-var:**
- Просто, atomic, не требует миграции.
- Изменение требует redeploy — это **plus** для secure case (нет «бот добавит чужой
  chat_id через rogue команду»).

**Pros таблицы:**
- Динамика (бот-команда `/allow @username`).
- Audit trail (когда добавили, кем).

**Рекомендация.** **Env-var** (твой текущий план). Аргументы:
- MVP: один пользователь (англоязычный клиент) + опционально Atsyhan как admin.
- Никакой динамики не предполагается.
- Изменение whitelist = переменная в Railway secrets, переразвёртывание (autodeploy).
- **Действие**: invariant уже зафиксирован правильно. Ничего менять.

### 19. Memory: плоско vs metadata

**Развилка из вопроса.** См. пункт 4 — рекомендация добавить `input_kind`, `llm_metadata_json`,
`telegram_message_id`, `voice_transcript_raw`. **Не плоско**.

Tool_calls в metadata НЕ нужны (invariant `no_tool_use` запрещает function calling).

### 20. Receipt timestamps: epoch vs TIMESTAMPTZ

**Развилка.** В `processed_emails` предложено `received_epoch_seconds BIGINT`. В календаре —
`TIMESTAMPTZ`. Это **рассогласование**.

**Решение.** Везде `TIMESTAMPTZ`. Epoch — только в API-вызовах (n8n contract принимает
epoch — конвертируем на границе кода в TIMESTAMPTZ для хранения).

### 21. Cleanup: cron vs lazy

**Развилка.** Cleanup expired pending — отдельный cron или ленивая проверка при чтении?

**Решение.** Cron каждый час (`DELETE WHERE expires_at < now()`). Lazy-check при чтении
тоже можно, но cron гарантирует, что таблицы не растут бесконечно даже если читать никто
не будет.

### 22. Owner identifier — `chat_id` vs `user_id`

**Малая развилка.** Везде используется `chat_id`. Для private chat этого достаточно. Но
Telegram различает `chat_id` (для private = `user_id`, для group = негативный chat-id) и
`from.id` (всегда user_id того, кто отправил).

**Для нашего MVP**: private chat only (нет group-режима) → `chat_id == user_id`. Можно
называть как угодно. Оставить `chat_id` (соответствует Telegram API соглашению).

**Если в будущем group**: ввести `user_id BIGINT` отдельно (для атрибуции в group),
`chat_id` оставить как «куда отвечать».

---

## ✅ Что выглядит ОК

- `calendar_events.gcal_etag` ✓ — наследие правильное из Sensei-tsy, для безопасного patch.
- `calendar_events.status` lifecycle `pending → active → cancelled → superseded` ✓.
- `processed_emails.gmail_message_id` UNIQUE PK ✓ — корректная защита идемпотентности.
- `audit_log.performed_at DEFAULT now()` ✓.
- `pending_*.telegram_message_id` — линковка к карточке ✓.
- Append-only триггер для `audit_log` ✓.
- Использование `TIMESTAMPTZ` для большинства timestamps ✓.
- Хранение `raw_gcal_response_json JSONB` ✓ (полезно для debug, согласовано с Sensei-tsy).

---

## Финальная схема (с учётом всех правок)

```sql
-- ============================================================
-- conversation_messages — память диалога
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
  id                       TEXT PRIMARY KEY,  -- 'ce-' || substring(encode(sha256(...), 'hex') from 1 for 12)
  dedup_key                TEXT NOT NULL UNIQUE,  -- '<chat_id>:<tg_msg_id>:<event_seq>'
  source_message_id        BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  source_chat_id           BIGINT NOT NULL,  -- denormalized для быстрого партиционирования по chat
  gcal_event_id            TEXT NULL,         -- nullable до Google insert
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
  expires_at               TIMESTAMPTZ NOT NULL  -- для cleanup unresolved
);
CREATE INDEX idx_oe_status ON outgoing_emails (status, expires_at);

-- ============================================================
-- pending_conflict_decisions — 4-кнопочная карточка конфликта
-- ============================================================
CREATE TABLE pending_conflict_decisions (
  id                         BIGSERIAL PRIMARY KEY,
  chat_id                    BIGINT NOT NULL,
  telegram_message_id        BIGINT NOT NULL,  -- ID карточки в Telegram
  new_event_spec             JSONB NOT NULL,   -- что хотел создать
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
  target_event_id          TEXT NULL REFERENCES calendar_events(id),  -- nullable пока pick не сделан
  candidates_json          JSONB NULL,  -- {[id, summary, start_at]…} при multiple match
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
-- audit_log — append-only журнал
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
  chat_id                  BIGINT NULL,  -- денормализация для удобства запросов
  before_json              JSONB NULL,
  after_json               JSONB NULL,
  reason                   TEXT NULL,
  performed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, performed_at DESC);
CREATE INDEX idx_audit_chat_time ON audit_log (chat_id, performed_at DESC) WHERE chat_id IS NOT NULL;

-- Триггер: REJECT UPDATE / DELETE
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
-- system_kv — служебное состояние
-- ============================================================
CREATE TABLE system_kv (
  key                      TEXT PRIMARY KEY,
  value_text               TEXT NULL,
  value_json               JSONB NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- updated_at trigger (helper)
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ce_updated_at BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Итого таблиц: 8** (вместо 7 в исходной + 1 удалена pending_outgoing_emails как
сliteral subset outgoing_emails + 2 добавлено: outgoing_emails, system_kv = +1 нетто).

---

## Конкретные действия перед feat-005

### Обязательно

1. **Обновить description feat-005** в `feature_list.json`:
   - Перечислить все 8 таблиц (вместо 7).
   - Упомянуть `outgoing_emails` вместо `pending_outgoing_emails`.
   - Добавить `system_kv`.
   - Сослаться на этот документ как канонический спек.

2. **Принять решения по развилкам** (см. секцию «Спорные»):
   - audit_log универсальный ✓ (рекомендация).
   - pending-таблиц 2 отдельных (после поглощения pending_outgoing_emails) ✓.
   - whitelist env-var ✓.
   - memory с metadata (input_kind, llm_metadata, voice_transcript_raw, telegram_message_id).
   - timestamps везде TIMESTAMPTZ.
   - all-day через discriminated columns.
   - dedup_key стабильный `<chat_id>:<tg_msg_id>:<event_seq>`.

3. **Обновить `domain-rules.yaml` invariants**:
   - В `calendar_event_traceable` — уточнить FK `conversation_messages(id) ON DELETE
     RESTRICT`.
   - В `email_idempotent_no_double_notify` — добавить explicit «at-most-once: помечаем
     processed ДО отправки notification, упущенное письмо лучше дубля».
   - Новый invariant `mail_send_traceable`: для каждого отправленного письма строка в
     `outgoing_emails` со ссылкой на исходный conversation_message.
   - Новый invariant `pending_expiry_cleanup`: каждая pending-таблица имеет `expires_at`,
     cleanup cron раз в час.
   - Новый disambiguation_trigger `awaiting_new_time_user_input` (см. пункт 5).

4. **Добавить новые маленькие фичи** в `feature_list.json`:
   - `feat-024` (S) — «Pending cleanup cron» (зависимость от feat-005).
   - `feat-025` (S) — «Orphan calendar_events recovery on startup» (зависимость от feat-005).
   - `feat-026` (S, future) — «Archive old conversation_messages» (не MVP).

### Желательно (можно после первой реализации)

5. **Добавить кратко-документ** `docs/features/feat-005/state-machines.md` — диаграммы FSM
   для:
   - calendar_events status lifecycle.
   - pending_conflict_decisions state transitions (awaiting_button ↔ awaiting_new_time).
   - pending_event_edits state transitions (awaiting_pick → awaiting_button).
   - outgoing_emails status lifecycle.

6. **Setup ESLint/sql-lint rule** или просто code-review CHECK что в коде:
   - Все INSERT в `audit_log` используют типизированную обёртку `auditAppend()` а не
     прямой SQL — для контроля JSONB структуры по `entity_type`.

---

## Что я НЕ ПРОВЕРИЛ (вне scope этого reviewer)

- Performance под нагрузку (мониторинг latency пишет в БД, индексы выбраны эвристически —
  EXPLAIN'ы делать после первого реального load).
- Backup strategy для Postgres (Railway managed имеет автобэкап, но frequency / retention
  не проверен).
- Row-level security (multitenant=false → не нужно).
- Migrations tooling (drizzle / kysely / pure SQL — выбор стека отдельная фича).

---

## Контекст и легитимность ревью

Reviewer — отдельный Opus 4.7 запущенный как Agent с fresh context, **не** в основном
harness flow. Прочитал все указанные файлы. Не зависит от предыдущих сессий или
in-context bias. Соответствует правилу `~/CLAUDE.md` § «Reviewer перед моделями данных».

Жёсткие правки нужны до старта feat-005. Спорные развилки — зафиксировать решения в
`feature_list.json` + `domain-rules.yaml`. Это даст модели застыть в правильной форме с
первой реализации (вместо переделок задним числом).
