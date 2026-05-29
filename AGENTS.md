# AGENTS.md — BabkaVitalika

**Telegram-бот для клиента: Google Calendar + Gmail через n8n-OAuth, хостинг на Railway.**
Пользователь пишет боту обычным языком → бот создаёт/правит/отменяет события в Google Calendar
и присылает краткие выжимки новых входящих писем Gmail. Google Drive — отложено на будущее.

> **Контекст происхождения.** Календарная часть портируется с проекта `~/Coding/Sensei-tsy`
> (life-agent). Референс-документы лежат в `docs/reference/calendar-from-sensei/` — это рабочая
> сводка как сделан календарь там (HANDOFF.md и др.). НО инфраструктура другая: OAuth держит
> n8n (облако), хостинг — Railway, добавлена почта, и **весь продукт на английском**.

## Кто заказчик и кто пользователь

- **Заказчик** — Атсыхан (ставит задачу, общается со мной по-русски). НЕ программист, кода не пишет.
  Портрет: `~/PortraitMD/USER_PORTRAIT.md` — обязательное чтение перед осмысленным ответом.
- **Конечный пользователь бота** — клиент Атсыхана (англоязычный). Платит за n8n-облако,
  сам проходит Google-авторизацию через n8n (ему так проще).

## Язык — критичный инвариант

- **Продукт (всё, что видит конечный пользователь): только английский.** Сообщения бота,
  кнопки, карточки, тексты выжимок писем, ошибки, /start, /help — English. Без исключений.
- **Общение со мной (Атсыхан) и внутренние доки/код-комментарии — русский/технический**, как обычно.
- Разделение жёсткое: `domain-rules.yaml > invariants > product_language_english`.

## Как разговаривать с заказчиком (из портрета)

1. Концепт сверху, детали по запросу. Не вываливать код/синтаксис в чат.
2. Варианты с плюсами/минусами + обоснованная рекомендация — когда есть реальная развилка.
3. Технические термины — только с пояснением последствий в скобках.
4. 1-2 вопроса за раз; если развилок много — структурированный список с вариантами.
5. «Готово» = команда верификации прошла И поведение наблюдалось. Не «код написан».
6. Делать молча: выбор библиотек, имена, форматирование, git, чтение стек-трейсов.
7. НЕ оценивать в человеко-днях — размеры S/M/L и количество фич.

## Архитектура (треугольник)

```
Telegram (англ. UI)
      │
      ▼
Бот на Railway (TypeScript)  ──HTTP webhook──►  n8n workflow (наш, ОТДЕЛЬНЫЙ)
      │  Telegram + понимание (LLM)                ноды Gmail / Google Calendar
      │  + оркестрация. Токенов Google НЕ хранит.   используют credential "Mari" (OAuth2)
      │                                                   │
      │                                                   ├──► Google Calendar (CRUD, занятость)
      ▼                                                   └──► Gmail (читает входящие)
Postgres на Railway (зеркало событий, обработанные письма, audit-журнал)
```

**n8n credentials клиента (готовы, использовать в нодах нового workflow):** «Mari» Gmail OAuth2 API +
«Mari» Google Calendar OAuth2 API (созданы 11 May). Существующие 11 workflows клиента НЕ трогаем.

- **n8n = только держатель и поставщик доступа** (вариант, выбранный заказчиком). НЕ выполняет
  операции календаря/почты. Как именно n8n отдаёт токен наружу — см. research feat-001
  (n8n по дизайну прячет креды, нужен проверенный механизм — НЕ гадать).
- **Бот сам** работает с Google Calendar API и Gmail API.
- **LLM** — Haiku через OpenRouter (НЕ подписка Claude Code — продукт не зависит от подписки).

## Что переиспользуем из Sensei-tsy

Логика (переносится, промпты → на английский): детектор событий, intent-детектор
(create/modify/cancel), fuzzy-матчер событий, проверка занятости слота, карточки Telegram.
Заменяется: слой Google целиком — вместо прямых вызовов Google API бот дёргает webhook нашего
n8n workflow (ноды Gmail/Calendar с credential Mari). Хранилище (SQLite на Mac → Postgres на
Railway), хостинг (LaunchAgent → Railway).

## Главные инварианты (полный список — domain-rules.yaml)

1. **product_language_english** — весь пользовательский текст на английском.
2. **n8n_executes_google_via_nodes** — Google-операции выполняет наш отдельный n8n workflow (ноды с credential Mari), бот дёргает его через webhook и токенов Google не хранит.
3. **calendar_event_traceable / audit_trail** — каждое событие связано с сообщением, все
   изменения пишутся в append-only журнал (наследие reviewer'а Sensei-tsy).
4. **verify_in_real_google** — «готово» = состояние в реальном Google (events.get / Gmail API),
   не запись в нашей Postgres.
5. **no_silent_calendar_creation** — на каждое созданное событие приходит карточка в Telegram.
6. **email_idempotent_no_double_notify** — одно письмо уведомляется ровно один раз.

## Стек

- **Бот**: TypeScript + grammy (Telegram). Деплой на Railway.
- **БД**: Railway Postgres (managed — не теряется при перезапуске; SQLite на Railway эфемерен).
- **Google**: через наш n8n workflow (ноды Gmail/Calendar с credential Mari). Бот — HTTP-клиент к webhook, напрямую `googleapis` не использует.
- **LLM**: OpenRouter (Haiku) — выжимки писем, детекция событий, intent.
- **Голос**: открытая развилка (feat-002) — на Railway нет локального whisper.

## Working Rules (harness)

- **WIP=1**: одна фича в `active` за раз.
- **Verification обязательна**: фича не `passing` пока verification_command не зелёный И не
  проверено в реальном Google.
- **Data-model reviewer** перед feat-005 (схема Postgres) — отдельный критический Opus-агент.
- **Vendor research** перед фиксацией способа n8n→token (feat-001).
- **Surgical changes**: не трогать файлы вне `affected_files`.
- **Clean state на выход**: SESSION.md + feature_list.json обновлены до конца сессии.

## Startup Workflow

1. `pwd` → `/Users/gypsy/Coding/BabkaVitalika`
2. Прочитать этот AGENTS.md
3. `domain-rules.yaml` — инварианты и скоуп
4. `docs/reference/calendar-from-sensei/HANDOFF.md` — как устроен календарь-образец
5. `feature_list.json` — текущий скоуп и волны
6. `SESSION.md` — где остановились
7. `error-journal.md` — известные грабли

## Anti-patterns

- ❌ Гадать про механизм n8n→token без research (vendor research rule).
- ❌ Хардкод абсолютных путей (на Railway другое окружение — всё через env vars).
- ❌ Tool use на средних моделях — структурированный JSON по схеме, код реагирует.
- ❌ Объявлять «готово» по записи в нашей БД (только реальный Google).
- ❌ Русский текст в продукте (всё user-facing — английский).
- ❌ Technical A/B заказчику — «беру X, потому что Y».
- ❌ Зависимость продукта от подписки Claude Code (LLM через OpenRouter API-ключ).
