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

## ⚡ NEXT SESSION / следующий шаг

**`/architecture`** — V0 архитектура треугольника бот(Railway) ↔ n8n(OAuth) ↔ Google(Calendar+Gmail).
Главный фокус — граница «бот ↔ n8n» (как получаем токен) и «бот ↔ Google» (Calendar + Gmail).

Перед /architecture закрыть открытые развилки (в чате с заказчиком):
1. **Голос** — нужен ли голосовой ввод (feat-002)? На Railway нет локального whisper.
2. **Почта — охват**: какие письма уведомлять (все входящие / важные / фильтр)? Частота опроса?
3. **Почта — формат**: выжимка по одному письму или дайджест пачкой?
4. **Часовой пояс** клиента (Sensei-tsy был Europe/Minsk).

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
