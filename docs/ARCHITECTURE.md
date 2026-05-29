# BabkaVitalika — Architecture

> Зафиксировано на `/architecture` 2026-05-29. Версия V0 (упрощённая, ≤10 компонентов).
> При расхождениях с этим документом фиксируем причину в `error-journal.md`.

## 1. Что система делает (одна фраза)

Telegram-бот, который понимает естественный язык на английском, через **отдельный n8n
workflow** клиента создаёт/переносит/отменяет события в его Google Calendar и присылает
выжимки новых писем Gmail. Бот хостится на Railway, Google-OAuth держит и применяет n8n.

## 2. Треугольник (V0)

```
                 ┌─────────────────────────────────────────────┐
                 │              КОНЕЧНЫЙ ПОЛЬЗОВАТЕЛЬ          │
                 │           (англоязычный, US-East TZ)        │
                 └───────────────────┬─────────────────────────┘
                                     │ Telegram (текст)
                                     ▼
                       ┌─────────────────────────────┐
                       │     БОТ на Railway          │
                       │     (TypeScript + grammy)   │
                       │                             │
                       │  ┌───────────────────────┐  │
                       │  │ Telegram adapter      │  │  принимает сообщения, шлёт карточки
                       │  ├───────────────────────┤  │
                       │  │ LLM-логика (Haiku 4.5)│──┼─► OpenRouter API
                       │  │  • intent detector    │  │
                       │  │  • event detector     │  │
                       │  │  • email summarizer   │  │
                       │  │  • fuzzy event matcher│  │
                       │  ├───────────────────────┤  │
                       │  │ Orchestrator          │  │  state-machine, dedup, retries
                       │  ├───────────────────────┤  │
                       │  │ n8n HTTP client       │──┼─► n8n webhook (см. ниже)
                       │  ├───────────────────────┤  │
                       │  │ Gmail polling cron    │  │  каждые 15 мин
                       │  └───────────────────────┘  │
                       └────────────┬────────────────┘
                                    │ SQL
                                    ▼
                       ┌─────────────────────────────┐
                       │   Railway Postgres          │
                       │  • calendar_events          │  зеркало + dedup_key + status
                       │  • calendar_event_audit     │  append-only журнал
                       │  • processed_emails         │  gmail_message_id UNIQUE
                       └─────────────────────────────┘

         ┌────────────────────── HTTP POST + X-Webhook-Secret ─────────┐
         │                                                              │
         ▼                                                              │
┌─────────────────────────────────────────┐                             │
│   N8N (techconstruction.app.n8n.cloud)  │                             │
│   ОТДЕЛЬНЫЙ workflow «BabkaVitalika».   │                             │
│   Существующие 11 workflows клиента     │                             │
│   НЕ трогаем.                           │                             │
│                                         │                             │
│   ┌──────────────┐                      │                             │
│   │ Webhook node │ ◄────────────────────┼─────────────────────────────┘
│   │ (Header Auth)│                      │
│   └──────┬───────┘                      │
│          ▼                              │
│   ┌──────────────┐                      │
│   │ Switch by    │                      │
│   │ body.action  │                      │
│   └──────┬───────┘                      │
│          ├────► Calendar nodes ─────────┼─► Google Calendar API
│          │       (creds Mari)           │
│          └────► Gmail nodes ────────────┼─► Gmail API
│                  (creds Mari)           │
│                                         │
│   ┌──────────────┐                      │
│   │ Respond to   │ ◄──── собирает ответ │
│   │   Webhook    │                      │
│   └──────────────┘                      │
└─────────────────────────────────────────┘
```

## 3. Ответственности компонентов

| Компонент | За что отвечает | Что НЕ делает |
|---|---|---|
| **Telegram adapter** | приём/отправка сообщений, карточек, callback-кнопок | LLM, бизнес-логика |
| **LLM-логика** | детекция событий, intent, выжимки писем, fuzzy-матчинг | вызовы Google, БД |
| **Orchestrator** | state-machine intent → команда n8n, дедупликация, retry | LLM, прямой Google |
| **n8n HTTP client** | формирует JSON, добавляет `X-Webhook-Secret`, парсит ответ | бизнес-логика |
| **Gmail polling cron** | раз в 15 мин дёргает `gmail.listNew` через n8n | LLM (это делает summarizer) |
| **Postgres** | хранит зеркало календаря, audit-log, processed_emails | реальное состояние Google (это в Google) |
| **n8n workflow** | принимает webhook, по `action` дёргает нужную ноду Gmail/Calendar | LLM, понимание языка пользователя |

**Главная архитектурная граница**: бот = мозг (LLM-понимание + оркестрация), n8n = руки
(стандартный исполнитель Google-операций). Между ними — фиксированный JSON-контракт.

## 4. Что выбрали и почему (vs Marie AI Assistant Demo)

Live-образец у клиента — Marie AI Assistant Demo — кладёт **весь функционал в один n8n
workflow с AI Agent внутри**, function calling. Это просто, но:

- Tool-use на средних моделях ненадёжен (инвариант `no_tool_use`).
- Нет audit-журнала, нет защиты от дублей при повторе команды.
- Нет активного опроса Gmail (Demo читает почту только по запросу).
- Логика «зашита» в system prompt — её нельзя локально потестировать.

Наш выбор: **бот = мозг, n8n = руки**. Плюсы:

- LLM не делает function call (наш инвариант), JSON по схеме + валидатор.
- Полный audit + dedup в Postgres → traceable, recoverable.
- Активный опрос Gmail на стороне бота → push-уведомления в Telegram.
- Логика тестируется e2e в боте без n8n (моки HTTP-клиента).

Минусы:
- Больше инфраструктуры (бот + Postgres + n8n + Telegram = 4 компонента вместо одного).
- Чуть больше latency (HTTP-хоп бот→n8n→Google, ~200-400 мс на вызов).

## 5. Закрытые решения (на этом этапе)

| Решение | Значение | Дата | Источник |
|---|---|---|---|
| Язык продукта | English only | 2026-05-29 | заказчик |
| Голос | Только текст | 2026-05-29 | заказчик (feat-002 rejected) |
| Часовой пояс | America/New York (GMT-4) | 2026-05-29 | заказчик + evidence из Demo |
| Формат почты | По одному письму, выжимка в Telegram | 2026-05-29 | заказчик |
| Частота опроса Gmail | Каждые 15 мин | 2026-05-29 | заказчик |
| Где LLM | На боте (Haiku 4.5 через OpenRouter) | 2026-05-29 | архитектурный инвариант |
| Где OAuth Google | В n8n (credentials Mari) | 2026-05-29 | заказчик |
| Существующие 11 workflows | НЕ трогаем, создаём отдельный | 2026-05-29 | заказчик |
| Mari Gmail OAuth2 ID | `Md2WkyvHQvxM6hIm` | 2026-05-29 | тест-workflow `SPy33sUxuJPPodnf` |
| Mari Google Calendar OAuth2 ID | `XTKqqE3rzW0zdb6b` | 2026-05-29 | тест-workflow `SPy33sUxuJPPodnf` |

## 6. Открытые решения (на /detail-architecture или позже)

- **Имя бота в Telegram** — будет ли свой бот клиента или Атсыхан создаст через BotFather.
- **Хостинг Postgres** — Railway Postgres (план) vs Supabase (если нужен RLS).
- **Расширение до отправки писем** — Demo умеет, мы пока нет; вернуться если попросит клиент.
- **Recurring events** — Demo не делает, мы не делаем; вернуться, если нужно.
- **Утренняя сводка дня** — captured-фича, не в MVP.

## 7. Top-3 риска

| Риск | Mitigation |
|---|---|
| n8n-инстанс может упасть — у нас зависимость на сервис клиента | Бот ставит команду в очередь Postgres, ретраит до успеха; alarm в Telegram админу при >5 мин недоступности |
| Mari OAuth может протухнуть (Google требует Publish App для долгого refresh) | Сейчас credential работает в живом Demo — значит app в Publish mode; если упадёт 401 — алёрт админу, n8n UI re-auth |
| Gmail квота при опросе раз в 15 мин на пустом ящике | 4 пустых вызова/час = пыль в квоте 1B units/day, не риск; рассчитан запас 250000× |

## 8. Контракт webhook бот ↔ n8n

Полный контракт — `docs/n8n-workflow-contract.md`. Кратко: HTTP POST на единственный
webhook-URL с body `{ action, idempotency_key, payload }`, ответ JSON с `ok|error`.
`X-Webhook-Secret` шапка — общий секрет в env обеих сторон.

Поддерживаемые action:
- `calendar.createEvent`
- `calendar.modifyEvent`
- `calendar.cancelEvent`
- `calendar.listEvents` (для конфликт-чека и для матчера правки)
- `gmail.listNew` (poll)
- `gmail.getMessage` (тело для выжимки)
