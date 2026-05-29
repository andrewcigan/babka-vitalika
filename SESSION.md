# SESSION — BabkaVitalika

**Last Updated:** 2026-05-29
**Mode:** FAST (5 этапов)
**Active Feature:** null (feat-001 done)
**Pipeline stage:** new-project ✓ → /architecture ✓ → feat-001 ✓ → /feature feat-003 next

## Что это

Telegram-бот для клиента Атсыхана: **Google Calendar** (создать/перенести/отменить события из
Telegram) + **Gmail** (выжимки новых писем в Telegram). OAuth держит **n8n** (облако клиента),
хостинг — **Railway**, БД — **Railway Postgres**. **Весь продукт на английском.**
Календарная часть — порт логики из `~/Coding/Sensei-tsy` (см. `docs/reference/calendar-from-sensei/`).

## Сделано в этой сессии (2026-05-29)

- Bootstrap harness: AGENTS.md, domain-rules.yaml, feature_list.json, SESSION.md, .gitignore.
- Перенесены референс-доки календаря Sensei-tsy в `docs/reference/calendar-from-sensei/`.
- Railway-токен сохранён в `~/.env.shared` (RAILWAY_API_TOKEN / RAILWAY_TOKEN).
- Зафиксированы решения заказчика: скоуп (календарь + почта), n8n = только держатель доступа,
  n8n уже в облаке (платит клиент), всё на английском.
- Черновой план по волнам (feature_list.json, 10 фич, волны 0-3).

## Инструменты n8n (установлены 2026-05-29)

- **MCP n8n-mcp** (czlonkowski v2.56.0) — user scope, ПОЛНЫЙ режим (20 инструментов), привязан к
  инстансу клиента `techconstruction.app.n8n.cloud`. Креды в `~/.env.shared` (N8N_API_URL + N8N_API_KEY).
- **Плагин скиллов n8n-mcp-skills** v1.9.0 (czlonkowski) — 7 скиллов (выражения, паттерны workflow,
  валидация, ноды, JS/Python). **Активируются после рестарта сессии.**
- **Разведка инстанса:** 11 workflows у клиента — Telegram-боты (TechReceipt, UVSReceipt, W9),
  "AI Telegram Bot Agent: Smart Assistant & Content Summarizer", "Morning Briefing", "Onboarding Bot
  Document Intake", "Marie AI Assistant".

## Уточнение роли n8n (2026-05-29, решение заказчика)

n8n НЕ отдаёт токен наружу — он **выполняет** Google-операции нодами. Готовые credential клиента:
- **«Mari» Gmail OAuth2 API** — id `Md2WkyvHQvxM6hIm`
- **«Mari» Google Calendar OAuth2 API** — id `XTKqqE3rzW0zdb6b`

ID получены 2026-05-29 через тест-workflow `SPy33sUxuJPPodnf` (заказчик создал, привязал creds, прислал JSON).

- feat-001: создать ОТДЕЛЬНЫЙ n8n workflow с webhook; ноды Gmail/Calendar используют эти credential.
- Бот дёргает webhook (feat-004), токенов Google не хранит.
- Существующие 11 workflows клиента НЕ трогать.
- Workflow собирать через n8n-mcp (MCP подключён к инстансу `techconstruction.app.n8n.cloud`).

## Сделано в этой сессии (2026-05-29 part 2)

- **/architecture ✓** — `docs/ARCHITECTURE.md` (V0 + треугольник + ответственности + trade-offs vs Demo) + `docs/n8n-workflow-contract.md` (6 actions, JSON-форматы, retry, коды ошибок).
- Изучен **Marie AI Assistant Demo** — он использует AI Agent внутри n8n c function calling, мы расходимся в пользу strict state-machine на боте.
- Закрыты все open_decisions: timezone=America/New_York, формат почты=по одному, опрос=15 мин.
- Получены ID Mari credentials через тест-workflow `SPy33sUxuJPPodnf`:
  - Gmail OAuth2: `Md2WkyvHQvxM6hIm`
  - Google Calendar OAuth2: `XTKqqE3rzW0zdb6b`
  - зафиксированы в memory: `memory/project_mari_credentials.md`
- Создан **Header Auth credential** `BabkaVitalika Webhook Secret` (id `6jJgWCR0vCWqftod`), секрет в `~/.env.shared` как `N8N_WEBHOOK_SECRET_BABKAVITALIKA`.
- Создан workflow **`BabkaVitalika — Bot Webhook Gateway`** (id `32kQ1TjwzpRxcPZn`, 16 нод, active, URL: https://techconstruction.app.n8n.cloud/workflow/32kQ1TjwzpRxcPZn).
- Структура: Webhook (Header Auth) → Switch by action → 6 веток (Calendar create/update/delete/list + Gmail list/get с creds Mari) → 6 Set ответных нод → Respond to Webhook. Fallback ветка для unknown action.

## Финализация feat-001 (2026-05-29 part 3)

- Калибровка Calendar нод: `mode: "list"` + email `donnellycd@gmail.com` (пользователь подтвердил из UI Mari credential). Это и есть Gmail клиента.
- Добавлен `alwaysOutputData: true` на Calendar List + Gmail List New (иначе при 0 результатах downstream Set/Respond не запускались).
- Фильтр на Set Response List/Gmail List — отбрасывает «фейковые» items при alwaysOutputData.
- Smoke-тесты пройдены: listEvents empty/today, gmail.listNew empty, bad-secret 403.

## ⚡ NEXT SESSION

Активные фичи: **нет**. Следующая по графу — `feat-003` (каркас бота на Railway) или `feat-005` (модель данных Postgres).

Рекомендация: начать с **feat-003** (Railway + TypeScript + grammy + healthcheck + env-конфиг) — он не зависит от других и нужен чтобы потом feat-004 (HTTP-клиент к n8n) дёрнул наш живой webhook.

Что сделать в начале feat-003:
1. Создать Railway-проект через CLI (token в `~/.env.shared:RAILWAY_API_TOKEN`).
2. `npm create grammy@latest` (или ручной bun init), подключить `grammy` + `@types/node`.
3. `/start` и `/help` отвечают на английском.
4. Подключить Railway Postgres add-on, проверить connection string в env.
5. Healthcheck endpoint `/healthz` → `{ok:true}`.
6. Deploy + проверить работоспособность бота в Telegram.

**Тест-workflow `SPy33sUxuJPPodnf`** — больше не нужен, можно удалить через n8n UI (Workflows → SPy33...→ Delete).

## Открытые блокеры

Нет.

## Ключевые отличия от Sensei-tsy (что переписываем)

| Аспект | Sensei-tsy | BabkaVitalika |
|---|---|---|
| OAuth Google | самописный refresh-token | n8n держит и отдаёт |
| Хостинг | Mac mini (LaunchAgent) | Railway |
| БД | SQLite (локальный диск) | Railway Postgres |
| Язык продукта | русский | английский |
| Голос | whisper.cpp локально | развилка (Whisper API или нет) |
| Скоуп | вся свалка+классификация | только календарь + почта |

## Артефакты

- `AGENTS.md` — контекст и правила
- `domain-rules.yaml` — инварианты, скоуп, открытые решения
- `feature_list.json` — план по волнам
- `docs/reference/calendar-from-sensei/` — образец календаря (HANDOFF.md и др.)
