# Календарь Sensei-tsy — handoff документ

> Этот документ — полная сводка по блоку календаря для передачи следующему разработчику
> (человеку или агенту). Закрывает feat-12a / 12b / 12c / 12e — все PASSING на 2026-05-29.
> feat-12d (рефлексия) — captured в backlog, не реализована.

## 0. TL;DR

Бот принимает в Telegram сообщения вида «встреча с Катей завтра в 15», «перенеси встречу с Катей
на 16», «отмени встречу с Катей». На каждое сообщение:
1. Сохраняется raw (`feat-01`).
2. Голос расшифровывается через whisper (`feat-02`).
3. Классификатор (Haiku) определяет категорию (task / idea / note / material / project) (`feat-04`),
   шлёт мини-карточку «понял: …» с кнопками [не так]/[удалить] (`feat-12a`).
4. **Intent-детектор** (Haiku) определяет — это новое событие или команда правки/отмены (`feat-12c`).
   - Новое → детектор событий извлекает {title, datetime, all_day} (`feat-12b`).
   - Перед созданием — **проверка занятости слота** через Google events.list (`feat-12e`).
   - Если свободно → создаём в Google + карточка «📅 Создал…».
   - Если занято → карточка конфликта с 3 кнопками.
5. Команда правки → fuzzy-поиск целевого события, карточка «🔄 Меняю: было X → станет Y» + [Да]/[Отмена].
6. Команда отмены → карточка «🗑 Отменить» + [Да]/[Отмена].

Все изменения в реальном Google Calendar (events.insert / patch / delete). В нашей SQLite хранится
зеркало + audit-log.

## 1. Зачем (бизнес-обоснование)

Атсыхан — предприниматель с СДВГ. У него много встреч, поездок, договорённостей. Он часто
**забывает заходить в календарь руками** — пишет себе в Telegram «надо встретиться с Петей завтра
в 3», а потом сюрприз (никуда не записано).

Цель блока календаря — закрыть этот gap: всё что говорится в бот про время → попадает в Google
Calendar автоматически, с быстрой возможностью поправить если бот понял неточно.

**Будущее (feat-12d)** — после события бот спрашивает «как прошло, где был, что работало?». Ответы
копятся в `event_reflections`, идут в портрет пользователя (фаза 3 концепта Life Agent — система
понимает «что у тебя работает, а что выматывает»). Без этих данных портрет неполный.

## 2. Что в коде сейчас (фичи)

| Фича | Что делает | State | Где детали |
|---|---|---|---|
| `feat-12a` | Карточка «понял: …» на каждое классифицированное сообщение + кнопки коррекции | passing | `src/telegram/classification-card.ts` |
| `feat-12b` | Создание событий из сообщений + карточка «📅 Создал» + [🗑 Удалить] | passing | `src/calendar/detector.ts`, `calendar-worker.ts` |
| `feat-12c` | Правка/отмена через текст («перенеси на 16», «отмени») | passing | `intent-detector.ts`, `event-matcher.ts`, `calendar-edit-dispatcher.ts` |
| `feat-12e` | Проверка занятости слота перед созданием, карточка конфликта | passing | `conflict-resolver.ts`, `calendar-conflict-card.ts` |
| `feat-12d` | Опрос «как прошло» после события + таблица рефлексий | captured | план в `feature_list.json`, не реализовано |

## 3. Архитектура (общий поток)

```
Telegram сообщение
   │
   ▼
TelegramAdapter (src/telegram-adapter.ts)
   │  сохраняет raw в users/<slug>/raw/YYYY-MM-DD/HH-MM-XX.md
   │  для голоса — voiceWorker через whisper.cpp
   │
   ▼  onRawSaved() / onTranscribed()
ClassifyWorker (src/classify/classify-worker.ts)
   │  Haiku classify → category + direction + summary + confidence
   │  пишет в classified_messages + classification_history
   │  отправляет «понял: …» карточку (feat-12a)
   │
   ▼  outcome.kind = "classified" | "uncertain", outcome.message_id
runCalendarDetect() (src/index.ts)
   │
   ▼
CalendarEditDispatcher (src/calendar/calendar-edit-dispatcher.ts)
   │
   │   ┌── 1. classifiedRepo.get(messageId) → text
   │   ├── 2. calendarRepo.listActive({from: now-30д, to: now+30д}) → active events
   │   ├── 3. IntentDetector.detect(text, activeEvents) → intent
   │   │       (предфильтр regex — если в тексте нет «перенеси/отмени/удали/...»
   │   │        → intent=create мгновенно БЕЗ LLM-вызова)
   │   │
   │   ├── intent.kind === "create" ────────────┐
   │   │                                        │
   │   ├── intent.kind === "modify" ──┐         │
   │   ├── intent.kind === "cancel" ──┤         │
   │   └── intent.kind === "none" → noop        │
   │                                  │         │
   │   ┌──────────────────────────────┘         │
   │   │                                        │
   │   ▼                                        ▼
   │   findTargetEvent(description, active)    CalendarWorker.processMessage()
   │   (fuzzy Jaccard матчер,                       │
   │    src/calendar/event-matcher.ts)              │  CalendarDetector.detect(text)
   │   ├── found → buildModify/CancelConfirmCard    │  (Haiku → events[])
   │   │   + pendingEditStore.set(chatId, edit)     │
   │   ├── multiple → buildPickCard + pendingEdit   │  для каждого ev (timed):
   │   │   c candidates                             │
   │   └── not_found → «🤷 Не нашёл такой встречи»  │  ConflictResolver.check(ev)
   │                                                │  (events.list по окну ев event;
   │                                                │   findConflict с skipAllDay)
   │                                                │
   │                                                │  ├── blocked → buildConflictCard
   │                                                │  │   + pendingConflictStore.set
   │                                                │  │   событие НЕ создаётся
   │                                                │  └── свободно → calendarApi.createEvent
   │                                                │      + repo.createPending + markActive
   │                                                │      + buildCalendarCard «📅 Создал»
   │                                                │
   ▼                                                ▼
[карточка ушла пользователю в Telegram через bot.api.sendMessage]
```

После клика по кнопке (callback_query):
```
bot.on("callback_query") (src/index.ts)
   │  диспатчер по префиксу callback_data:
   │   - clf_*       → ClassificationCallbackHandler
   │   - cal_del:*   → CalendarCallbackHandler.handleDelete (feat-12b удаление)
   │   - cal_edit_*  → CalendarCallbackHandler.handleEdit (feat-12c подтверждение)
   │   - cal_pick:*  → handleEdit (выбор кандидата)
   │   - cal_conflict_*  → handleConflict (feat-12e)
   │   - остальное   → projects CallbackHandler (feat-04)
   │
   ▼
CalendarCallbackHandler (src/telegram/calendar-callback-handler.ts)
   │
   │  for cal_edit_yes (modify):
   │    ├── читает pendingEditStore[chatId] → {kind, new_start_iso, new_end_iso}
   │    ├── calendarApi.patchEventTime(gcal_event_id, {start, end})
   │    ├── repo.patchTime(id, ..., {actor:"user", reason:"user_modified_via_card"})
   │    │   (это пишет audit row patch_time с before/after)
   │    ├── editMessage(card_message_id, «✅ Перенёс в календаре»)
   │    └── store.delete(chatId)
   │
   │  for cal_edit_yes (cancel): аналогично, deleteEvent + repo.cancel
   │  for cal_edit_no: store.delete + edit «✖ Оставил как было»
   │  for cal_pick:<id>: подменяет event_id в pending, отрисовывает confirm для выбранного
   │
   │  for cal_conflict_ok: создаёт событие из pendingConflictStore + edit «📌 Поставил поверх»
   │  for cal_conflict_drop: store.delete + edit «✖ Не стал ставить»
   │  for cal_conflict_old: edit с подсказкой «напиши: перенеси «X» на <время>» (без stateful)
```

## 4. LLM-вызовы (Haiku 4.5 через OpenRouter)

Все три модели — `anthropic/claude-haiku-4.5`. Ключи через `key-request` CLI; fallback на env
`OPENROUTER_API_KEY` если флаг `LIFE_AGENT_ALLOW_ENV_OPENROUTER=1`.

### 4.1 Classifier (feat-04)

- **Когда:** каждое raw сообщение (текст или voice → транскрипция).
- **Промпт:** `src/classify/prompt.ts` — system + user. Извлекает `{category, direction,
  primary_entity_type, primary_entity_slug, project_slug, summary, confidence, perfectionism_flag,
  emotional_signals, entities}`. Категории: task / idea / note / material / project.
- **JSON schema validator** на ответе (response_format json_object + isValid в коде).
- **Стоимость:** ~1 вызов на сообщение. Eval gold-set 96% на 50 примерах.

### 4.2 IntentDetector (feat-12c, новое)

- **Когда:** после classify, ТОЛЬКО если предфильтр regex увидел императив правки/отмены
  (`перенес*` / `отмен*` / `удал*` / `убер*` / `сдвин*` / `поменя*` / `продли*` / `переимен*`).
  Иначе — `intent=create` мгновенно, БЕЗ LLM. Это экономит ~80% сообщений.
- **Промпт:** `src/calendar/intent-detector.ts buildIntentSystemPrompt()`. Возвращает JSON:
  ```
  {
    intent: "create" | "modify" | "cancel" | "none",
    target_event_id: "<id из списка активных>" | null,
    target_description: "...",
    new_start_iso: "...",
    new_end_iso: "...",
    new_all_day: bool,
    confidence: 0..1
  }
  ```
- **Контекст:** в user-промпте подставляется список активных событий за ±30 дней:
  `- id=ce-xxx | "Встреча с Катей" | 2026-05-30T15:00+03 → 16:00+03`.
- **Graceful fallback:** если Haiku упал или вернул невалид → intent=create (основной поток
  не блокируем).

### 4.3 CalendarDetector (feat-12b)

- **Когда:** после intent=create. Тоже с предфильтром (по словам «завтра/встреча/созвон/...» —
  см. `hasTemporalMarkers` в `detector.ts`).
- **Промпт:** `buildDetectorSystemPrompt()`. Возвращает `events[]` с {title, all_day, start_iso,
  end_iso, location, source_phrase, confidence, needs_clarification, clarification_reason}.
- **all-day vs timed логика:** встреча/звонок/обед с временем → timed (1ч дефолт если длительность
  не указана); отпуск/поездка/ДР на дату без времени → all-day. Часовой пояс Europe/Minsk
  (+03:00, без DST).
- **needs_clarification:** месяц без числа («поездка в июне») → событие НЕ создаём, шлём
  «📅 Похоже на событие, но не понял дату».

### Стоимость на одно сообщение

- Базовое («купить молоко»): 1 вызов (classify) ≈ $0.0001.
- Новое событие («встреча в 3»): 2 вызова (classify + detector) ≈ $0.0002.
- Команда правки («перенеси на 16»): 2 вызова (classify + intent), intent отрабатывает modify
  без вызова detector ≈ $0.0002.
- Конфликт: те же 2 вызова + Google events.list (бесплатно в квоте).

Бюджет в продакшене незаметный.

## 5. Схема данных (SQLite)

Таблицы добавлены миграциями V3 (см. `src/sqlite/schema.ts`):

### 5.1 `calendar_events`

| колонка | назначение |
|---|---|
| `id` (PK) | `ce-<sha256(dedup_key)[0:12]>` — детерминированный |
| `classified_message_id` (FK) | сообщение из которого извлечено |
| `dedup_key` (UNIQUE) | `<message_id>:<start_iso>` — idempotency guard |
| `gcal_event_id` | ID в Google после успешного insert |
| `gcal_etag` | etag для безопасного patch (предупреждение конкурентных правок) |
| `title`, `source_phrase`, `start_iso`, `end_iso`, `all_day`, `timezone`, `location` | данные события |
| `created_by` | `detector` / `user_telegram` / `user_web` |
| `status` | `pending` (резерв до Google insert) / `active` / `cancelled` / `superseded` |
| `raw_gcal_response_json` | сырой ответ Google для отладки |
| `created_at`, `updated_at`, `synced_at` | временные метки |

**Жизненный цикл:**
1. `createPending(...)` — резервирует строку status=`pending` ДО Google вызова (UNIQUE на dedup_key
   защищает от двойной попытки при recovery после рестарта).
2. `markActive(...)` — после `events.insert`, status → `active` + gcal_event_id.
3. `patchTime(...)` — обновление времени + audit с before/after (feat-12c modify).
4. `cancel(...)` — soft delete: status → `cancelled` (строку НЕ удаляем, FK из 12d требует
   reflection_traceable).

### 5.2 `calendar_event_audit` (append-only)

| колонка | назначение |
|---|---|
| `id` (PK auto) | |
| `calendar_event_id` (FK) | |
| `action` | `create` / `patch_time` / `patch_title` / `patch_location` / `cancel` / `delete` / `supersede` |
| `actor` | `detector` / `user` / `recovery` |
| `before_json`, `after_json` | для diff |
| `reason` | строка с пояснением (например `user_modified_via_card`) |
| `performed_at` | временная метка |

Триггеры на уровне SQLite запрещают UPDATE / DELETE этой таблицы — append-only.

### 5.3 Что НЕ менялось

Схема calendar_events / audit спроектирована Opus-reviewer'ом ещё в feat-12b
(`docs/features/feat-12/data-model-review.md`) — etag, audit, FK — всё было заложено под 12c
заранее. **При работе с feat-12d менять схему НЕ нужно** — только добавить `event_reflections`.

## 6. Conversational state (in-memory)

Два Map'а в `index.ts`, поднимаются при старте бота:

### 6.1 `PendingEditStore` (feat-12c)
- Key: `chat_id`.
- Value: `{kind: "modify"|"cancel", event_id, new_start_iso?, new_end_iso?, new_all_day?,
  description?, candidates?: string[], enqueued_at}`.
- Логика: после отправки confirm-карточки сохраняем то что должно случиться при клике [Да].
- TTL не enforced автоматически, но есть `clearStale(now, ttl_ms)` для будущего хука.

### 6.2 `PendingConflictStore` (feat-12e)
- Key: `chat_id`.
- Value: spec нового события (что хотел создать) + info о конфликтующем (`conflict_title`,
  `conflict_start_iso`, `conflict_end_iso`).
- При [Поставить всё равно] — создаём событие из этого spec'а.

**Почему in-memory:** при рестарте бота пользователь повторит команду. Persisting в БД ради
одного юзера — overhead без выгоды. План это явно разрешил.

## 7. Telegram UI

### 7.1 Карточки

| Что | Где собирается | Кнопки |
|---|---|---|
| Создание события | `buildCalendarCard` в `calendar-card.ts` | [🗑 Удалить] |
| Правка confirm | `buildModifyConfirmCard` в `calendar-edit-card.ts` | [✅ Да] [✖ Отмена] |
| Отмена confirm | `buildCancelConfirmCard` | [✅ Да] [✖ Отмена] |
| Выбор из кандидатов | `buildPickCard` | [<кандидат1>] [<кандидат2>] [✖ Отмена] |
| Конфликт слота | `buildConflictCard` в `calendar-conflict-card.ts` | [📌 Поставить всё равно] [✖ Не ставить] [🔄 Перенести существующее] |
| Уточнение даты | `buildClarificationText` | (без кнопок, просто текст) |

Финальные тексты после клика — `buildEditFinalText("modified"|"cancelled")`,
`buildConflictResolvedText`, `buildConflictDeclinedText`, `buildEditDeclinedText`,
`buildCalendarFinalText("deleted")`.

### 7.2 Callback-протокол

Префиксы (все ≤64 байта, как требует Telegram):

| Префикс | Где парсится | Что делает |
|---|---|---|
| `cal_del:<event_id>` | `parseCalendarCallback` | feat-12b: удалить из Google + cancel в БД |
| `cal_edit_yes:<event_id>` | `parseEditCallback` | feat-12c: применить modify/cancel из pendingEdit |
| `cal_edit_no:<event_id>` | `parseEditCallback` | feat-12c: отказ, очистить pending |
| `cal_pick:<event_id>` | `parseEditCallback` | feat-12c: выбрать кандидата из multiple |
| `cal_conflict_ok:<event_id>` | `parseConflictCallback` | feat-12e: создать поверх |
| `cal_conflict_drop:<event_id>` | `parseConflictCallback` | feat-12e: отказ |
| `cal_conflict_old:<event_id>` | `parseConflictCallback` | feat-12e: подсказка «напиши перенеси» |

`isCalendarCallback(raw)` в `calendar-card.ts` проверяет ВСЕ префиксы — это диспатчер первого
уровня в `bot.on("callback_query")` (см. `src/index.ts`).

`event_id` — это наш id из `calendar_events.id` (`ce-<hash>`), не gcal_event_id.

## 8. Google Calendar API

### 8.1 OAuth

- Credentials в `.env.gcal` (`GOOGLE_CALENDAR_CLIENT_ID/SECRET`, gitignored).
- Refresh-token в `.gcal-token` (gitignored, chmod 600). Получен через команду `/auth_calendar`
  в Telegram — бот шлёт ссылку, пользователь разрешает в браузере, копирует URL обратно
  в `/auth_code <url>`.
- **Scope:** `https://www.googleapis.com/auth/calendar.events`. Это позволяет CRUD событий, НО
  НЕ пускает `freebusy.query` (требует `calendar.readonly` или полный `calendar`). Поэтому в
  ConflictResolver используется `events.list` вместо freebusy — даёт те же интервалы плюс
  title для текста карточки одним round-trip.

### 8.2 Интерфейс `CalendarApi` (DI для тестов)

`src/calendar/google-client.ts`:
```typescript
interface CalendarApi {
  createEvent(spec): Promise<CreatedEvent>;
  patchEventTime(eventId, spec): Promise<CreatedEvent>;
  deleteEvent(eventId): Promise<void>;     // идемпотентно (404/410 = ok)
  getEvent(eventId): Promise<FetchedEvent>; // read-back для e2e верификации
  freeBusy(min, max): Promise<Interval[]>; // оставлен как stub, scope не пускает
  listEventsInRange(min, max): Promise<Event[]>; // используется в ConflictResolver
}
```

### 8.3 Идемпотентность и recovery

- `deleteEvent` ловит 404/410 → возвращает успешно (событие уже удалено).
- `createPending` бросает на UNIQUE dedup_key → расценивается воркером как `skipped_duplicates`.
- `listOrphanedPending` в репо возвращает строки status=pending без gcal_event_id —
  для recovery если бот упал между `createPending` и `markActive`.
- При CalendarAuthError (401 / invalid_grant) — воркер шлёт «⚠️ истёк доступ к Google Calendar.
  Переавторизуй /auth_calendar».

## 9. Verification стратегия

### 9.1 Auto-e2e (обязательно ДО объявления passing)

Два скрипта в реальный Google:

- `scripts/gcal-edit-e2e.ts` — modify (events.patch + getEvent подтверждает 16:00), cancel
  (events.delete + getEvent cancelled), not_found.
- `scripts/gcal-conflict-e2e.ts` — занятый слот (events.list увидел, карточка + pending),
  [Поставить всё равно] (events.insert + getEvent confirmed), свободный слот (blocked=false).

Cleanup в finally — все созданные тестовые события удаляются.

**Запуск:**
```
source ~/.env.shared && LIFE_AGENT_ALLOW_ENV_OPENROUTER=1 \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  bun run scripts/gcal-edit-e2e.ts
```

### 9.2 Layer 5 — пользовательская приёмка

Атсыхан 2026-05-29 прошёл сценарии в реальном Telegram-боте:
- A: «тест встреча с Захаром завтра в 23:00» → «перенеси на 23:30» → [Да] → getEvent в Google
  подтвердил 23:30 ✓
- B: «тест звонок завтра в 22:00» → «тест встреча с клиентом завтра в 22:30» → конфликт-карточка
  → [Поставить всё равно] → оба confirmed в Google ✓

Evidence в `feature_list.json` поля `layer_5_evidence`.

### 9.3 Помощник для read-back

`scripts/verify-acceptance.ts` — короткий скрипт который дёргает `getEvent` на 3 gcal_event_id
и печатает status/start/summary. Полезно для отладки после ручного прогона в боте.

### 9.4 Правило (из memory feedback)

**verify-in-real-external-service-not-our-db** — для фич с внешним сервисом «готово» = состояние
в РЕАЛЬНОМ сервисе через его API, НЕ запись `status='active'` в нашей БД. См.
`~/.claude/projects/-Users-gypsy-Coding-Sensei-tsy/memory/feedback_calendar_verify_real_google.md`.

## 10. Файлы кодовой базы (что где)

### Core логика
- `src/calendar/detector.ts` — извлечение событий из текста (Haiku, feat-12b).
- `src/calendar/intent-detector.ts` — определение intent create/modify/cancel/none (Haiku, feat-12c).
- `src/calendar/event-matcher.ts` — fuzzy Jaccard матчер целевого события (чистая функция).
- `src/calendar/calendar-worker.ts` — orchestrator: detect → conflict check → create event.
- `src/calendar/calendar-edit-dispatcher.ts` — orchestrator: intent → matcher → confirm-карточка.
- `src/calendar/conflict-resolver.ts` — events.list → findConflict → конфликт-карточка.
- `src/calendar/freebusy-check.ts` — чистая функция пересечения интервалов.
- `src/calendar/google-client.ts` — OAuth + Calendar API клиент (DI интерфейс CalendarApi).
- `src/calendar/pending-edit-store.ts` — in-memory state для confirmов правки.
- `src/calendar/pending-conflict-store.ts` — in-memory state для решений конфликта.

### Telegram UI
- `src/telegram/calendar-card.ts` — карточка создания + общий диспатчер isCalendarCallback.
- `src/telegram/calendar-edit-card.ts` — карточки правки/отмены/выбора.
- `src/telegram/calendar-conflict-card.ts` — карточка конфликта.
- `src/telegram/calendar-callback-handler.ts` — handler всех cal_* callback'ов.

### Хранилище
- `src/sqlite/calendar-events-repo.ts` — CRUD для calendar_events + audit.
- `src/sqlite/schema.ts` — DDL миграции V3 (calendar_events + calendar_event_audit).

### Wire-up
- `src/index.ts` — всё подключается тут. Особенно блок с заголовком `feat-12b: Google Calendar`
  (около строки 213) и `runCalendarDetect()` (около 324).

### Тесты
В `tests/` — 49 файлов всего, релевантные:
- `calendar-detector.test.ts`, `calendar-intent-detector.test.ts`
- `calendar-events-repo.test.ts`, `calendar-schema.test.ts`
- `calendar-edit-card.test.ts`, `calendar-conflict-card.test.ts`, `calendar-card.test.ts`
- `calendar-event-matcher.test.ts`, `calendar-freebusy-check.test.ts`
- `calendar-pending-edit-store.test.ts`, `calendar-pending-conflict-store.test.ts`
- `calendar-conflict-resolver.test.ts`
- `calendar-worker-smoke.test.ts`, `calendar-edit-callback-smoke.test.ts`,
  `calendar-edit-dispatcher-smoke.test.ts`

Всего 640 тестов pass, tsc clean.

### Скрипты (ad-hoc, не в pipeline)
- `scripts/gcal-auth.ts` — headless OAuth для refresh-token (если /auth_calendar не сработал).
- `scripts/gcal-detector-smoke.ts` — прогон detector на эталонной выборке через real Haiku.
- `scripts/gcal-edit-e2e.ts` — auto-e2e для feat-12c.
- `scripts/gcal-conflict-e2e.ts` — auto-e2e для feat-12e.
- `scripts/verify-acceptance.ts` — read-back helper.

### Документы планирования
- `docs/features/feat-12/scope-and-decisions.md` — решения по feat-12b.
- `docs/features/feat-12/data-model-review.md` — Opus-reviewer схемы БД.
- `docs/features/feat-12/conflict-check-and-editing-plan.md` — детальный план 12c+12e.
- `docs/features/feat-12/oauth-setup.md` — что пользователь делает в браузере.

## 11. Архитектурные решения (что НЕ очевидно из кода)

### 11.1 Intent отдельным шагом, не в Detector

В плане было обсуждение — расширить промпт CalendarDetector или сделать отдельный intent-шаг.
Выбран отдельный, потому что:
- Чистое разделение «извлечь событие» vs «понять команду» — одна функция = одна ответственность.
- Предфильтр regex даёт быстрый short-circuit: ~80% сообщений (новые события) идут в старый
  поток БЕЗ второго LLM-вызова.
- Если бы intent был в детекторе — сложнее было бы добавить новые intent типы (например
  «расскажи про мои встречи завтра»).

### 11.2 events.list вместо freebusy.query в ConflictResolver

OAuth scope `calendar.events` не даёт freeBusy. Мы могли расширить scope до `calendar.readonly`,
но это:
- Требует повторной OAuth авторизации пользователя.
- Даёт ненужный full-read доступ к календарю (мы только проверяем конкретное окно).

`events.list` с `singleEvents: true` + `timeMin/timeMax` даёт то же самое + title (бонус для текста
карточки). One round-trip вместо двух (freebusy + events.list для title).

Метод `freeBusy` в `CalendarApi` интерфейсе **оставлен как stub** — реализован в клиенте, но не
используется. Если расширим scope в будущем — можно переключиться.

### 11.3 fail-open в ConflictResolver

Если `events.list` упал (сеть / 5xx / auth-ошибка) — `blocked=false`. Не блокируем основной поток
feat-12b. Принцип: лучше создать событие без проверки конфликта, чем сломать создание совсем.

### 11.4 all-day не блокирует timed

Бизнес-правило: «отпуск с 5 по 12 июня» не блокирует «встреча в 10:00 8 июня». Реализовано
через `findConflict({skipAllDay: true})`. Если нужна обратная логика (например для «не ставить
встречи в отпуск») — добавить отдельную проверку с opts.skipAllDay=false.

### 11.5 Conversational state в памяти, не в БД

Pending edit / conflict переживают только живой процесс бота. При рестарте Атсыхан повторит
команду. Альтернатива (таблица `pending_edits` в SQLite) усложняет схему и решение для одного
пользователя — overkill. План это разрешил явно.

### 11.6 Конфликт-карточка — упрощённый MVP

План предлагал кнопки [Поставить] / [Перенести новую — скажи когда] / [Перенести ту что была].
Я реализовал:
- [📌 Поставить всё равно] — как в плане.
- [✖ Не ставить] — вместо «Перенести новую». Пользователь сам отправит новую команду
  «звонок в 18» если хочет перенести новую встречу. БЕЗ stateful flow.
- [🔄 Перенести существующее] — бот отправляет подсказку «напиши: перенеси «X» на <время>».
  Пользователь повторяет команду → она проходит через feat-12c механизм.

Stateful «жди новое время» не реализован — это требует ещё одного состояния («ждём текстовый
ответ с временем»), что усложняет conversational state. Атсыхан в Layer 5 принял упрощённый
вариант. Если в будущем скажет «нужно прямо ждать новое время» — добавить.

### 11.7 Predfilter для intent (regex)

`hasModifyCommandMarkers(text)` — `src/calendar/intent-detector.ts:74`. Намеренно широкий —
ложные срабатывания (например «отмен» в слове «отменно») приведут к лишнему intent-вызову,
который вернёт `create`/`none`. Это не страшно — потеря $0.0001. Главное чтобы НЕ пропустил
реальные команды правки (false negative = баг).

Если будут жалобы что Haiku зря зовётся на «отлично», «удалось» — расширить регулярки на
полные формы (`перенеси`, `отмени` целиком).

### 11.8 Detector confidence порог

В CalendarDetector нет жёсткого порога confidence — всё что не `needs_clarification` создаётся.
Атсыхан принимает что если бот не уверен — он сможет [🗑 Удалить] на карточке. Если будут
ложные создания — добавить порог 0.5 или 0.6.

## 12. Что не сделано / куда дальше

### 12.1 feat-12d — рефлексия после события (captured)

Описание в `feature_list.json`:
> Cron worker раз в час: смотрит calendar_events с end_time за последний час + не опрошенные →
> шлёт в Telegram «🎤 Как прошла [название]?». Ответ голосом или текстом сохраняется в новой
> таблице event_reflections (id, calendar_event_id FK, reflection_text, sentiment, created_at).

**План реализации (когда возьмут):**
1. Новая таблица `event_reflections` (миграция V4).
2. Cron-job в `src/calendar/reflection-worker.ts` — каждый час смотрит `listFinishedNotSurveyed()`.
3. Шлёт в Telegram голосовой запрос (или текстовый).
4. Ответ пользователя через нормальный flow (raw → classify) — но с пометкой это ответ на
   рефлексию (через reply_to_message_id или conversational state).
5. Сохранение в `event_reflections` с привязкой к calendar_event_id.

**Зависимости:**
- feat-12b ✓
- voice-worker ✓ (для голосового ответа)

**Использование:** в фазе 3 (Portrait wiki) рефлексии анализируются LLM-ом для построения
профиля пользователя.

### 12.2 Stateful diалог на [Перенести существующее] / [Перенести новую]

Сейчас бот шлёт подсказку и ждёт обычную команду от пользователя. Можно сделать stateful flow:
- Сохранить в conversational state «жду текстовый ответ с новым временем для события X».
- Перехватывать следующее текстовое сообщение пользователя, использовать intent-detector
  с подсказкой «контекст: переносим event_id=X».
- Применить перенос без явного [Да].

Размер: ~M (3-4 часа). Не блокер.

### 12.3 Утренняя сводка дня

«Сегодня у тебя 5 встреч, основное — Катя в 15». Cron каждое утро в 8:00. Полезно для
структурирования дня (СДВГ компенсация). Размер S (1-2 часа). Не в плане, но Атсыхан упомянул.

### 12.4 Recurring events

Сейчас detector не поддерживает повторяющиеся события («каждый понедельник в 10»). Google API
поддерживает через `recurrence` field (`RRULE:FREQ=WEEKLY;BYDAY=MO`). Размер M, требует
расширения detector промпта.

### 12.5 Расширение intent-типов

Сейчас 4 intent'a (create/modify/cancel/none). Можно добавить:
- `query` — «что у меня завтра?» → бот шлёт список.
- `bulk_modify` — «отмени всё на завтра».
- `link_to_project` — «привяжи встречу к проекту Изи Штандарт».

Каждое — отдельная фича.

## 13. Известные тонкости / грабли

### 13.1 listActive окно ±30 дней

`CalendarEditDispatcher.dispatch()` зовёт `listActive({from: now-30, to: now+30})`. Если
пользователь скажет «перенеси встречу с Катей через 3 месяца на час позже» — событие через
3 месяца НЕ в окне → fuzzy не найдёт → not_found.

Решение в будущем: расширять окно до 90 дней, или брать окно из `intent.new_start_iso` если он есть.

### 13.2 OAuth Testing mode

Если на Google Cloud Console приложение в Testing mode — refresh-token живёт 7 дней. После
истечения бот шлёт «⚠️ истёк доступ к Google Calendar, переавторизуй». Решение: опубликовать
приложение (Publish App) для многолетнего refresh-token.

### 13.3 WAL conflict при бэкапе SQLite

`feat-07a` (бэкап в GitHub) должен использовать `sqlite3 .backup` команду, НЕ просто копирование
`.db` файла — иначе WAL-journal не закрыт и копия будет неконсистентной.

### 13.4 callback_data 64-байтовый лимит

Telegram режет всё что > 64 байт. Все наши префиксы рассчитаны: `cal_edit_yes:ce-aabbccddeeff` =
27 байт. Если добавлять новые префиксы — следить.

### 13.5 Whisper hallucinations

Голос с тишиной даёт «Субтитры от...», «Спасибо за просмотр». Hallucination detector
(`src/hallucination-detector.ts`) ловит их и шлёт «не распознал, скинь текстом». При работе
с календарём важно: если HW пропустит галлюцинацию — classifier может выдать `category: idea`
с уверенностью, detector создаст несуществующее событие. Если будут жалобы — поднять порог
detector confidence до 0.7.

### 13.6 Один primary календарь

Используем только `calendarId: "primary"`. Если у Атсыхана несколько календарей — все события
идут в primary. Поддержка нескольких — отдельная фича (новые поля в calendar_events.gcal_calendar_id
уже есть в схеме под это).

### 13.7 Часовой пояс жёстко Europe/Minsk

Если Атсыхан летит в Дубай и пишет «встреча в 15» — будет 15:00 Minsk, не Dubai. Поддержка
динамической tz требует определения текущей зоны (из Apple Health / IP / явно настроить).

## 14. Запуск проекта

```bash
# Установить зависимости
bun install

# Проверки
bun tsc --noEmit
bun test

# Запустить локально для разработки (НЕ конкурировать с production-ботом!)
# Production-бот запущен через LaunchAgent com.sensei-tsy.bot
# Локально лучше брать второй Telegram бот-токен (см. AGENTS.md).

bun src/index.ts

# Auto-e2e
source ~/.env.shared
LIFE_AGENT_ALLOW_ENV_OPENROUTER=1 OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  bun run scripts/gcal-edit-e2e.ts
LIFE_AGENT_ALLOW_ENV_OPENROUTER=1 OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  bun run scripts/gcal-conflict-e2e.ts

# Production бот
# Перезапуск:
launchctl kickstart -k gui/$(id -u)/com.sensei-tsy.bot
# Логи:
tail -F /Users/gypsy/Coding/Sensei-tsy/logs/bot.log
```

## 15. Глоссарий

- **Raw** — первый слой хранения, сырые сообщения в `users/<slug>/raw/YYYY-MM-DD/HH-MM-XX.md`.
  Append-only.
- **Classified** — слой 3, результат classify-worker'а. SQLite таблица `classified_messages`.
- **Detector** — Haiku-извлекатель событий из текста. Не путать с IntentDetector.
- **IntentDetector** — Haiku-определитель intent (create/modify/cancel/none).
- **CalendarEditDispatcher** — orchestrator поверх classify-результата. Routes intent → нужное
  действие.
- **ConflictResolver** — orchestrator перед createEvent. Проверяет слот.
- **PendingEdit / PendingConflict** — in-memory state «жду подтверждения / решения».
- **gcal_event_id** — ID события в Google Calendar (НЕ наш id).
- **dedup_key** — `<message_id>:<start_iso>`, гарантирует что событие создаётся только раз
  даже при recovery после рестарта.
- **Layer 5** — пользовательская поведенческая приёмка (Атсыхан проходит сценарии в боте,
  смотрит результат в своём Google Calendar).
- **auto-e2e** — скрипты которые прогоняют полный путь в реальный Google Calendar +
  read-back через `events.get` ДО объявления passing.

## 16. Для следующего разработчика / агента

1. **Прочитай `AGENTS.md`** — общие правила проекта.
2. **Прочитай `SESSION.md`** — где остановились + что планируется дальше.
3. **Этот документ** — для понимания календарного блока.
4. **План feat-12c+12e:** `docs/features/feat-12/conflict-check-and-editing-plan.md` — там был
   детальный план до реализации; в этом документе расхождения с планом отмечены явно
   (раздел 11.6, 11.7).
5. **Memory:** `~/.claude/projects/-Users-gypsy-Coding-Sensei-tsy/memory/` — feedback-файлы
   с правилами от пользователя (особенно `feedback_calendar_verify_real_google.md`,
   `feedback_binary_answer_first.md`, `feedback_dont_send_user_to_terminal.md`).
6. **Архив сессий с реализацией:** git log с 2026-05-29:
   - `524aed4` feat(feat-12c): правка и отмена событий через текст
   - `e901baa` feat(feat-12e): проверка занятости слота перед постановкой
   - `d0a607b` feat(feat-12c+12e): PASSING — Layer 5 в реальном Google подтверждён
   - `e6d0e12` docs(handoff): блок календаря закрыт, следующая фича feat-07a (бэкап)
