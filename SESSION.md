# SESSION — BabkaVitalika

**Last Updated:** 2026-05-29
**Mode:** FAST (5 этапов)
**Active Feature:** null (план зафиксирован, реализация не начата)
**Pipeline stage:** new-project ✓ → дальше /architecture

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
**«Mari» Gmail OAuth2 API** + **«Mari» Google Calendar OAuth2 API** (созданы 11 May).
- feat-001 (бывший research) → теперь: создать ОТДЕЛЬНЫЙ n8n workflow с webhook; ноды Gmail/Calendar
  используют эти credential. Бот дёргает webhook (feat-004), токенов Google не хранит.
- Существующие 11 workflows клиента НЕ трогать.
- Workflow собирать через n8n-mcp + скиллы n8n (после рестарта сессии).

## ⚡ NEXT SESSION / следующий шаг (новая сессия после перезапуска — активны MCP+скиллы n8n)

Автозапуск: `~/bin/next-session.sh BabkaVitalika` (заготовка в `.session-state/next-prompt.txt`).

1. Через **n8n MCP** посмотреть существующие workflows клиента — как используются ноды с
   credential Mari (Gmail/Calendar). Живой образец «как правильно».
2. **`/architecture`** — контракт webhook бот↔n8n (какие команды, формат вход/выход) + треугольник.
3. **feat-001** (up_next) — собрать ОТДЕЛЬНЫЙ n8n workflow с нодами Mari (через n8n-mcp + скиллы).

Решено 2026-05-29: голос НЕ нужен (текст); почта — ВСЕ входящие; n8n выполняет Google-операции
нодами (credential Mari), бот дёргает webhook; n8n-mcp привязан к инстансу клиента (креды в ~/.env.shared).

Уточнить на /architecture (не блокирует): формат почты (по одному / дайджест), частота опроса Gmail,
часовой пояс клиента.

## Открытые блокеры

- **feat-001 (research n8n-токен)** — блокирует feat-004 и всю Google-интеграцию.
  n8n прячет креды по дизайну → механизм отдачи токена нужно проверить, не гадать.

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
