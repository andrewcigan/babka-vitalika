# feat-12 — Календарь + фидбек классификации

> Зафиксировано 2026-05-28 по итогам проработки в чат-сессии.
> Все решения — выбор Атсыхана, не «по умолчанию».

## Контекст и боль

**Боль 1 (видимая):** Атсыхан забывает заходить в Google Calendar руками. Сообщения типа «надо бы внести в календарь поездку в Дубай», «встреча с Петей завтра в 3» — пишутся в бот, но дальше никуда. События не попадают в календарь — потом сюрприз.

**Боль 2 (диагностическая, выявлена при разборе):** Бот тих после `ack`. На сообщение «надо бы внести в календарь поездку в Дубай» он:
- Записал в raw ✓
- Classify-worker отработал ✓ (categoty=note, confidence=0.0, state=uncertain)
- В Telegram ничего не ответил — потому что код шлёт `sendProjectCard` только при детектировании нового проекта, а на task/idea/note/material — тишина

То есть классификация **технически идёт**, но пользователь её не видит. Это маскирует баги классификатора (про «надо бы...» он провалился в note вместо idea/task — confidence 0.0).

## Решение — две связанные фичи

### feat-12a (S) — фидбек классификации
Бот всегда отвечает мини-карточкой что и как понял + кнопки коррекции. Перестаёт быть «молчуном». Параллельно правится промпт classifier чтобы «надо бы X» не падало в note.

### feat-12b (L) — Google Calendar
Calendar-detector worker второго этапа после классификации (изолирован, не ломает работающие 42 классификации). Если в сообщении есть событие — создаёт в Google Calendar и шлёт карточку управления.

**Делаем последовательно: 12a → 12b.** 12a даёт живой фидбек уже к концу первой итерации, 12b ставится поверх работающего диалога.

## Принципиальные решения (зафиксированы)

| Вопрос | Решение | Источник |
|---|---|---|
| Подтверждение перед созданием? | НЕТ. Бот создаёт сразу, шлёт карточку «создал X» с кнопками управления (изменить/удалить). | Атсыхан 2026-05-28: «нет потока подтверждений, инлайн-кнопки потом» |
| Длинные события (отпуск, поездки) | **All-day events** в Google (start.date + end.date эксклюзивно), НЕ timed с 00:00-00:00 | Атсыхан: «очень важно чтобы у Google было с 00:00 до 00:00, а не сверху ставилось» |
| Если время не указано | Карточка с кнопкой `[Оригинальный]` (оставить как сказал пользователь, без часов = all-day) | Атсыхан: «скажу оригинальный» |
| Если длительность не указана | Дефолт **1 час** для timed events | Атсыхан: «давай 1 час» |
| Если участники не указаны | Пусто (никого не приглашать) | Атсыхан: «тоже пустым» |
| Часовой пояс | **Europe/Minsk** фиксированно | Атсыхан: «это Minsk» |
| Календарей | **Один** основной (gmail primary) для MVP | Атсыхан: «один календарь пока, не-не пока» |
| Связь с узлами дерева life-agent | Пока никак | Атсыхан: «про узлы дерева вообще никак пока» |
| Изменения/отмены через бот | Отложено в feat-12c | Атсыхан: «сейчас только создавать, потом — нужно полное управление» |
| Опрос после события | Отложено в feat-12d (из бывшего post-mvp-001) | Из feat-post-mvp-001 + решение разбить L на этапы |
| Проверка конфликтов перед созданием | Не делаем сейчас | Не критично для MVP |
| Apple Calendar | НЕТ | Нет нормального API, только CalDAV; Google Calendar — стандарт |

## Логика all-day vs timed (важно!)

Это самое тонкое место. Calendar-detector promptом извлекает признаки:

| Текст пользователя | Тип события | Поля Google API |
|---|---|---|
| «встретиться с Петей завтра в 3» | timed | `start.dateTime=2026-05-29T15:00:00+03:00`, `end.dateTime=2026-05-29T16:00:00+03:00` (1ч дефолт) |
| «обед в 13:30 в среду» | timed | `start.dateTime=2026-06-03T13:30:00+03:00`, `end.dateTime=2026-06-03T14:30:00+03:00` |
| «встреча с Х завтра в 15-17» | timed | `start.dateTime=2026-05-29T15:00:00+03:00`, `end.dateTime=2026-05-29T17:00:00+03:00` (длительность 2ч из текста) |
| «отпуск с 5 по 12 июня» | all-day | `start.date=2026-06-05`, `end.date=2026-06-13` (end эксклюзивно!) |
| «поездка в Дубай 10 июня» | all-day | `start.date=2026-06-10`, `end.date=2026-06-11` |
| «командировка 1-3 июля» | all-day | `start.date=2026-07-01`, `end.date=2026-07-04` |
| «день рождения 5 июля» | all-day | `start.date=2026-07-05`, `end.date=2026-07-06` |
| «поездка в Дубай в июне» (только месяц) | **исключение** | НЕ создаём — карточка с уточнением «когда конкретно? пришли дату» |

Все timed события — в часовом поясе `Europe/Minsk`.

## Архитектура — где какой код

```
src/calendar/
  detector.ts          ← Haiku промпт, извлечение event из classified_messages
  google-client.ts     ← googleapis SDK, events.insert/get/update/delete
  oauth-setup.ts       ← installed-app flow с локальным callback на localhost:N

src/sqlite/
  calendar-events-repo.ts          ← CRUD для calendar_events таблицы
  schema.ts                        ← +таблица calendar_events

src/telegram/
  classification-card.ts  ← НОВАЯ (feat-12a)
  calendar-card.ts        ← НОВАЯ (feat-12b)
  callback-handler.ts     ← +обработчики кнопок обеих карточек
  commands.ts             ← /auth-calendar команда

src/index.ts             ← wire-up

.gcal-token              ← refresh_token хранение (chmod 600, gitignored)
gcal-credentials.json    ← OAuth client config от пользователя (gitignored)
```

**Принципиально:** calendar-detector — отдельный воркер второго этапа, НЕ изменения в feat-04 classify-worker. Изоляция = не ломаем 42 работающие классификации.

## БД-миграция (feat-12b)

```sql
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  classified_message_id TEXT NOT NULL REFERENCES classified_messages(id),
  gcal_event_id TEXT NOT NULL,
  gcal_calendar_id TEXT NOT NULL DEFAULT 'primary',
  title TEXT NOT NULL,
  start_iso TEXT NOT NULL,       -- ISO 8601 либо date либо dateTime
  end_iso TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','superseded')),
  raw_gcal_response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_ce_message ON calendar_events(classified_message_id);
CREATE INDEX idx_ce_gcal ON calendar_events(gcal_event_id);
CREATE INDEX idx_ce_start ON calendar_events(start_iso);
CREATE TRIGGER calendar_events_audit_update
BEFORE UPDATE ON calendar_events
BEGIN
  -- (опционально) audit-trail если нужно. Пока — просто разрешаем UPDATE.
  SELECT NULL;
END;
```

ОБЯЗАТЕЛЬНО **запустить отдельного критического Opus-агента-reviewer** перед коммитом схемы — по правилу из `~/CLAUDE.md` «Reviewer перед моделями данных».

## Refresh-token — почему живёт долго

Google OAuth refresh-token для desktop apps:
- **Production mode** OAuth client: refresh-token живёт **годами**, истекает только если 6 мес бездействия / отзыв доступа / смена пароля
- **Testing mode**: 7 дней (плохо)

Атсыхан выбрал Production mode (без verification — warning "App not verified" один раз). При первом OAuth он один раз пройдёт через `Advanced → Go to Sensei-tsy (unsafe)`, дальше refresh-token живёт. Если когда-то истечёт — бот шлёт в Telegram ссылку «переавторизуй», 30 сек.

## Что НЕ в скоупе feat-12 MVP

- Опрос после события → feat-12d (отдельная фича)
- Изменения/отмены через текст → feat-12c (отдельная фича)
- Множественные календари / выбор куда класть
- Приглашение участников
- Конфликт-проверка
- Связь с узлами дерева life-agent

## Verification (full list — см. feature_list.json)

**feat-12a:**
- 5 типов сообщений (task/idea/note/material + uncertain) → все приходят с карточкой
- Кнопки [не так] и [удалить] реально меняют state в БД
- «надо бы внести в календарь поездку в Дубай» больше не падает в note conf=0.0
- Layer 4 e2e: реальное сообщение в Telegram → карточка в течение 5 сек

**feat-12b:**
- 5 timed + 5 all-day сообщений → все события появляются в Google Calendar правильно
- OAuth flow проходит начисто, refresh-token реюзается после рестарта
- Кнопки [Удалить] / [Изменить дату] / [Изменить длительность] реально работают через events.delete / events.patch
- Layer 4 e2e: реальное сообщение → событие в Google Calendar в течение 10 сек

## Следующая сессия — что делать

```
cd ~/Coding/Sensei-tsy
./restart-here.sh
claude --effort xhigh --model opus
```

В Claude Code:
```
Продолжаем проект Sensei-tsy. Делаем feat-12a (фидбек классификации) — план в docs/features/feat-12/scope-and-decisions.md.
```

Агент:
1. Триггернёт `vibe-dev-v5:resume` (по фразе «продолжаем проект»)
2. Прочитает SESSION.md → секцию «Next session: feat-12»
3. Прочитает feature_list.json → увидит active=feat-12a
4. Прочитает этот файл (он явно указан в SESSION.md как cold-start file)
5. Запросит OAuth credentials у пользователя ИЛИ начнёт с feat-12a которая в них не нуждается
6. Пойдёт по `/vibe-dev-v5:feature feat-12a`

## Файлы которые читать первыми (cold-start order для feat-12)

1. `AGENTS.md` — общий контекст проекта
2. `SESSION.md` → секция «Next session: feat-12 plan» (после infra changes)
3. `feature_list.json` → запись `feat-12a-classification-feedback` (active) и `feat-12b-google-calendar` (up_next)
4. **`docs/features/feat-12/scope-and-decisions.md`** (этот файл) — все решения
5. **`docs/features/feat-12/oauth-setup.md`** — инструкция как пользователь получает Google credentials
6. `domain-rules.yaml` → инварианты (классификация, no_tool_use, capture_first_classify_later)
7. `~/.claude/projects/-Users-gypsy-Coding-Sensei-tsy/memory/MEMORY.md` → все feedback-правила, особенно `handoff-plan-persistence` (новое) и `no-silent-declaration`
