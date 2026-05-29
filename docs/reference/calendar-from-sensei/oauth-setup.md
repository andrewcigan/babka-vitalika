# OAuth setup для Google Calendar (feat-12b)

> Инструкция для пользователя — что сделать в браузере один раз чтобы бот получил доступ к Google Calendar.
> Время выполнения: ~10 минут.

## Что мы получаем в итоге

JSON-файл `gcal-credentials.json` с `client_id` и `client_secret` от OAuth-приложения, которое **ты сам владеешь** (свой Google Cloud Project). Положить в `~/Coding/Sensei-tsy/gcal-credentials.json`. После этого бот в первой OAuth-авторизации получит `refresh_token` (живёт годами), и будет писать в твой Google Calendar автономно.

## Шаг 1 — Создать проект в Google Cloud Console

1. Открой https://console.cloud.google.com
2. Сверху слева — селектор проекта → **«New Project»**
3. Имя: `Sensei-tsy Calendar` (видно только тебе)
4. Organization: оставь как есть (No organization, если нет рабочего G Suite)
5. **Create**, подожди 10 секунд, выбери созданный проект в селекторе

## Шаг 2 — Включить Google Calendar API

1. Слева в меню → **APIs & Services** → **Library**
2. В поиске набери `Google Calendar API`
3. Открой первый результат → нажми **Enable**

## Шаг 3 — Настроить OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**
2. User Type: **External** (Internal не доступен для personal Gmail) → **Create**
3. App information:
   - App name: `Sensei-tsy`
   - User support email: твой Gmail
   - Developer contact: твой Gmail
   - Остальное пустое → **Save and continue**
4. Scopes: ничего не добавляй → **Save and continue**
5. Test users: **+ Add Users** → впиши свой Gmail → **Save and continue**
6. Summary → **Back to dashboard**

**КРИТИЧЕСКИЙ выбор тут:**

- **Оставить в Testing mode** — refresh-token истекает каждые **7 дней**, придётся переавторизоваться раз в неделю (плохо)
- **Нажать «Publish App»** (на той же странице) — refresh-token живёт **годами**. Google покажет окошко «verification required», нажми ОК — приложение опубликуется. При OAuth ты один раз увидишь warning «Google hasn't verified this app» → кнопка **«Advanced» → «Go to Sensei-tsy (unsafe)»**. Для личного бота — нормально и безопасно (это твой собственный OAuth client, твой Gmail).

**Рекомендация: сразу Publish App.** Меньше боли.

## Шаг 4 — Создать OAuth Client ID

1. **APIs & Services** → **Credentials**
2. Сверху **+ Create Credentials** → **OAuth client ID**
3. Application type: **Desktop app** (важно — именно Desktop, не Web!)
4. Name: `Sensei-tsy bot`
5. **Create**
6. Появится диалог с Client ID и Client secret — нажми **«Download JSON»**

## Шаг 5 — Сохранить файл

Скачанный JSON будет называться типа `client_secret_NNNNNN.apps.googleusercontent.com.json`.

1. Переименуй его в `gcal-credentials.json`
2. Положи в папку проекта: `~/Coding/Sensei-tsy/gcal-credentials.json`
3. Файл будет добавлен в `.gitignore` агентом при реализации feat-12b (явно проверь!)

## Шаг 6 — (Опционально) Узнать Calendar ID

Если хочешь чтобы бот писал не в основной gmail-календарь, а в отдельный:

1. https://calendar.google.com → шестерёнка → Settings
2. Слева список календарей → выбери нужный → прокрути вниз до **«Integrate calendar»** → строка **«Calendar ID»**
3. Скопируй (выглядит как `длинная_строка@group.calendar.google.com`)

Если используешь основной — Calendar ID = `primary` (это просто слово), ничего узнавать не надо. В первой версии feat-12b код будет хардкодить `primary`. Поддержку других календарей добавим в feat-12b.1 если попросишь.

## Что произойдёт после Шага 5 — на стороне бота

(Это сделает агент в feat-12b, ты сейчас только в браузере действуешь)

1. Бот получит команду `/auth-calendar` в Telegram (от тебя)
2. Бот прочитает `gcal-credentials.json`, поднимет локальный HTTP-сервер на свободном порту (например `localhost:8765`)
3. Бот сформирует Google OAuth URL и пришлёт тебе в Telegram: «Открой эту ссылку в браузере: https://accounts.google.com/o/oauth2/v2/auth?...&redirect_uri=http://localhost:8765/...»
4. Ты откроешь, увидишь страницу Google «Sensei-tsy wants access to Google Calendar»
5. Если ты сделал **Publish App** — увидишь warning «App not verified» → кнопка **«Advanced» → «Go to Sensei-tsy (unsafe)»** → Allow
6. Google редиректнет на `http://localhost:8765/?code=...` → бот поймает callback, обменяет code на refresh_token, сохранит в `~/Coding/Sensei-tsy/.gcal-token` (chmod 600)
7. Бот ответит в Telegram: «✅ Google Calendar подключён»

После этого бот автономно создаёт события — никаких больше OAuth-действий от тебя не нужно (годами).

## Когда переавторизация всё-таки понадобится

- Прошло >6 месяцев без вызовов API (нам не грозит — бот регулярно создаёт события)
- Ты руками отозвал доступ через https://myaccount.google.com/permissions
- Сменил пароль Google
- Google закрыл OAuth client (редко)

В этих случаях бот при следующей попытке events.insert получит 401, поймает ошибку, и пришлёт тебе в Telegram «истёк refresh-token, переавторизуй: <новая ссылка>». 30 секунд.

## Что прислать агенту в следующей сессии

Когда сделаешь Шаги 1-5 — скажи в новой сессии:

> «OAuth credentials готов, файл `gcal-credentials.json` в проекте. App publish: done / testing. Calendar ID: primary / <твой ID>»

Если ещё не сделал — скажи прямо, агент пойдёт сначала по feat-12a (фидбек классификации, OAuth не нужен) пока ты не закончишь Шаги в браузере.
