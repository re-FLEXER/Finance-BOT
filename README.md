# Financial Telegram Bot — v4.5 Release Candidate

Telegram-бот для приватного фінансового обліку з інтеграцією Monobank, Gemini/Groq, PostgreSQL та фінансовими звітами. Це документація для реліз-кандидата v4.5; фактична версія пакета в `package.json` може мати окреме значення.

## Архітектура

```mermaid
flowchart TD
    Owner["Власник бота"]
    Telegram["Telegram Bot API"]
    Mono["Monobank webhook"]
    Clock["node-cron: Europe/Kyiv"]
    Monitor["Render health monitor"]

    subgraph HTTP["Express HTTP server"]
        TgRoute["POST /telegram/BOT_TOKEN"]
        MonoRoute["POST /monobank/MONO_SECRET"]
        Ping["GET /ping"]
    end

    subgraph App["index.js / Telegraf"]
        Allowlist["MY_CHAT_ID allowlist"]
        UpdateType{"Command, callback or text?"}
        Commands["Commands and callbacks"]
        Intent["Text intent classifier"]
        Advisor["AI advisor and chat history"]
        MonoAuth["Secret and payload validation"]
        Dedup["monoId deduplication"]
        MonoFlow{"Withdrawal or regular transaction"}
        Atomic["Withdrawal + fee: Prisma transaction"]
        ReportJobs["Daily, monthly, queue and backup jobs"]
    end

    subgraph Modules["Application modules"]
        Fallback["fallback-ai.js"]
        MonthlyAnalytics["monthly-analytics.js"]
        MonthlyAI["monthly-ai.js"]
        Csv["export-helpers.js"]
    end

    subgraph Providers["AI providers"]
        Gemini["Gemini: gemini-3.8-flash"]
        Groq["Groq: openai/gpt-oss-120b"]
    end

    Prisma["Prisma Client"]
    DB[("PostgreSQL")]

    Owner --> Telegram
    Telegram -->|HTTPS webhook| TgRoute
    TgRoute --> Allowlist
    Allowlist --> UpdateType
    UpdateType -->|command or callback| Commands
    UpdateType -->|ordinary text| Intent
    Intent -->|transaction / sync| Prisma
    Intent -->|chat| Advisor
    Advisor --> Fallback
    Commands -->|manual operation| Prisma
    Commands -->|export| Csv

    Mono -->|HTTPS with secret URL| MonoRoute
    MonoRoute --> MonoAuth --> Dedup --> MonoFlow
    MonoFlow -->|cash withdrawal| Atomic
    MonoFlow -->|regular operation| Fallback
    Atomic --> Prisma
    MonoFlow --> Prisma

    Clock --> ReportJobs
    ReportJobs --> MonthlyAnalytics
    ReportJobs --> MonthlyAI
    ReportJobs --> Fallback
    ReportJobs --> Csv
    ReportJobs -->|reports / backup| Telegram
    MonthlyAnalytics --> Prisma

    Fallback -->|primary| Gemini
    Fallback -->|on Gemini failure| Groq
    Prisma --> DB
    Monitor --> Ping
```

### Потоки обробки

- Telegram update надходить у Express-маршрут, що містить `BOT_TOKEN`, і передається Telegraf. Middleware пропускає тільки Telegram ID із `MY_CHAT_ID`; інші користувачі відхиляються.
- Текст поза режимом порадника проходить AI-класифікацію. Намір транзакції записується в БД, намір синхронізації коригує баланс, а звичайне запитання передається раднику.
- Monobank надсилає webhook на `/monobank/<MONO_SECRET>`. Після перевірки секрету й полів запиту обробник перевіряє `monoId`, класифікує операцію та створює запис. Зняття готівки й комісія створюються атомарно.
- AI-запити проходять через `fallback-ai.js`: основний провайдер Gemini `gemini-3.8-flash`, резервний — Groq `openai/gpt-oss-120b`. Щоденний AI-звіт може повторювати запит через retry helper; недоступний звіт зберігається у `ReportQueue` зі статусом `PENDING`.
- Дані зберігаються у PostgreSQL через Prisma. `Transaction.monoId` має бути унікальним для дедуплікації вебхуків.

## Можливості

- Облік доходів, витрат, заощаджень, переказів між карткою та готівкою, боргів і початкових балансів.
- Автоматичне розпізнавання фінансових операцій із тексту та Monobank webhook.
- Статистика, синхронізація балансу, скасування останньої операції та пакетів транзакцій.
- AI-радник зі збереженням короткої історії чату та режимом із тайм-аутом неактивності.
- Щоденний звіт, місячний AI-аудит, CSV-експорт і щотижневий CSV-бекап у Telegram.
- Доступ до команд обмежений власником бота.

## Команди Telegram

| Команда | Призначення |
| --- | --- |
| `/start` | Перевірити доступність бота. |
| `/help`, `/commands` | Показати команди. |
| `/stats` | Показати баланс, доходи, витрати, заощадження й борги. |
| `/setbalance <сума>` | Встановити початковий баланс картки. |
| `/sync <сума>` | Звірити баланс бота з фактичним залишком картки. |
| `/setsavings <сума>` | Синхронізувати загальну суму заощаджень. |
| `/debt <сума> <ім'я>` | Записати борг, який ви взяли. |
| `/lend <сума> <ім'я>` | Записати гроші, позичені іншій людині. |
| `/paydebt <сума>` | Записати погашення власного боргу. |
| `/getdebt <сума>` | Записати повернення позичених вам грошей. |
| `/undo` | Позначити останню транзакцію або її пакет як видалені. |
| `/reset` | Очистити всі транзакції та історію чату після підтвердження фразою `ОЧИСТИТИ ДАНІ`. Операція незворотна. |
| `/advice`, `/advisor`, `/ask` | Увійти в режим AI-радника. |
| `/endadvice`, `/exit`, `/stop`, `/off` | Завершити режим AI-радника. |
| `/add <сума> <опис>` | Додати ручну витрату з AI-класифікацією. |
| `/monthly` | Сформувати місячний фінансовий аудит. |
| `/export` | Експортувати всю історію транзакцій у CSV. |
| `/export month` | Експортувати поточний місяць у CSV. |

Звичайні текстові повідомлення також класифікуються. У режимі радника текст не записується як транзакція; сесія автоматично завершується після 20 хвилин неактивності.

## Модулі та дані

| Шлях | Відповідальність |
| --- | --- |
| `index.js` | Express/Telegraf, allowlist, команди, webhook-и, Prisma-записи, cron-задачі й HTTP server. |
| `fallback-ai.js` | Gemini/Groq failover для prompt і чату; повторні спроби для звітів. |
| `monthly-analytics.js` | Агрегація показників, боргів і категорій для місячного звіту. |
| `monthly-ai.js` | Формування запиту до AI-аудитора й обробка JSON-відповіді. |
| `export-helpers.js` | CSV-серіалізація й захист текстових комірок від formula injection. |
| `prisma/schema.prisma` | PostgreSQL-моделі та constraints. |
| `prisma/migrations/` | PostgreSQL baseline і міграція унікального `monoId`. |
| `stress-test.js` | DB/API stress перевірки та локальні security-тести. |

У Prisma є три моделі:

- `Transaction`: тип, сума, категорія, опис, простір, джерело, soft-delete, група пакета й унікальний nullable `monoId`.
- `ChatHistory`: коротка історія повідомлень користувача та AI.
- `ReportQueue`: збережені звіти, які не вдалося згенерувати під час першої спроби.

## Вимоги та конфігурація

- Node.js 20+ та npm.
- PostgreSQL і доступ до БД через Prisma.
- Telegram bot token від [@BotFather](https://t.me/BotFather).
- Gemini та Groq API keys для AI-функцій і fallback.
- Публічний HTTPS endpoint для production webhook-ів.

Створіть `.env` у корені проєкту та не додавайте його до Git:

```dotenv
BOT_TOKEN=telegram_bot_token
MY_CHAT_ID=123456789
DATABASE_URL=postgresql://user:password@host:5432/database?schema=public
DIRECT_URL=postgresql://user:password@host:5432/database?schema=public
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
MONO_SECRET=use_a_unique_random_secret_of_at_least_32_characters
PORT=3000
```

`MONO_SECRET` згенеруйте як випадкове значення щонайменше 32 символи, наприклад `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Не використовуйте буквальний placeholder із прикладу.

| Змінна | Призначення |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot API token; також входить до шляху Telegram webhook. |
| `MY_CHAT_ID` | Числовий Telegram ID власника, єдиний дозволений користувач бота. |
| `DATABASE_URL` | URL PostgreSQL для runtime-запитів Prisma; може бути pooler URL. |
| `DIRECT_URL` | Пряме PostgreSQL-підключення для Prisma migrations. |
| `GEMINI_API_KEY` | API key основного AI-провайдера. |
| `GROQ_API_KEY` | API key резервного AI-провайдера. |
| `MONO_SECRET` | Випадковий URL-секрет Monobank webhook, мінімум 32 символи. |
| `PORT` | HTTP-порт; за замовчуванням `3000`, Render задає автоматично. |
| `RENDER_EXTERNAL_URL` | Render public URL; якщо заданий, бот реєструє Telegram webhook під час запуску. |

Для PostgreSQL із connection pooler використовуйте pooler URL у `DATABASE_URL`, а direct URL — у `DIRECT_URL`.

## Локальний запуск

```powershell
npm ci
npx prisma generate
npx prisma migrate deploy
npm start
```

Health check: `http://localhost:3000/ping`, очікувана відповідь — `OK`. HTTP-приклади webhook-ів є у `test-api.http`; тестовий Monobank ID з префіксом `test_` не записується в БД. REST Client підставляє `MONO_SECRET` із локального `.env`.

### Міграції PostgreSQL

Для порожньої PostgreSQL бази `npx prisma migrate deploy` створює схему з baseline і додає unique index `Transaction_monoId_key`.

Для раніше створеної БД спочатку зробіть backup і переконайтеся, що таблиці та колонки відповідають `prisma/schema.prisma`. Якщо схема вже існує, одноразово позначте baseline застосованим і застосуйте наступні міграції:

```powershell
npx prisma migrate resolve --applied 20260928000000_baseline_postgresql
npx prisma migrate deploy
```

Не запускайте `migrate resolve` на порожній БД. Unique index не вдасться створити, якщо в `Transaction.monoId` є дублікати; перед deploy перевірте їх і розберіть вручну, не видаляючи фінансові записи автоматично.

## Розгортання на Render

1. Створіть Web Service із коренем репозиторію та PostgreSQL database.
2. Встановіть Build Command: `npm ci && npx prisma generate && npx prisma migrate deploy`.
3. Встановіть Start Command: `npm start` і Health Check Path: `/ping`.
4. Додайте `BOT_TOKEN`, `MY_CHAT_ID`, `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`, `GROQ_API_KEY` і `MONO_SECRET` у Render Environment.
5. Для наявної БД виконайте одноразовий baseline resolve до першого deploy з міграціями; Render build не повинен виконувати його автоматично.
6. Переконайтеся, що Telegram webhook зареєстрований на `https://<service>.onrender.com/telegram/<BOT_TOKEN>`.
7. У Monobank задайте webhook URL `https://<service>.onrender.com/monobank/<MONO_SECRET>`.

## Фонові задачі

Cron-задачі працюють у процесі Node.js за часовим поясом `Europe/Kyiv`:

| Розклад | Задача |
| --- | --- |
| Щодня о 23:54 | Розрахунок і відправка щоденного звіту; при недоступності AI звіт ставиться в `ReportQueue`. |
| Кожні 30 хвилин | Повторна обробка звітів `PENDING`. |
| В останній день місяця о 23:55 | Місячний аудит. |
| Щонеділі о 23:00 | Повний CSV backup у Telegram. |

Це in-process scheduler, не зовнішній durable queue. Використовуйте один постійно запущений інстанс: кілька реплік можуть дублювати cron-роботу, а sleep/restart може відкласти її. Стан режиму радника та cooldown для alert також зберігаються в пам’яті процесу й губляться після рестарту.

## Безпека та приватність

- **Telegram allowlist:** middleware звіряє `ctx.from.id` з `MY_CHAT_ID`; сторонні користувачі не отримують доступ до команд. Сповіщення про відмову та alert cooldown не замінюють rate limiting на рівні edge/proxy.
- **Telegram webhook:** шлях містить `BOT_TOKEN`, але окремий Telegram `secret_token` header не налаштований. Не публікуйте URL webhook і використовуйте HTTPS.
- **Monobank webhook:** `MONO_SECRET` має щонайменше 32 символи та порівнюється constant-time. Секрет є bearer credential у URL; URL може потрапити до access logs. Monobank-підпис тіла в цьому endpoint не перевіряється, тому застосовуйте унікальний секрет і ротайте його при витоку.
- **Webhook payload:** endpoint перевіряє наявність ID та числової суми; Express JSON parser використовує стандартний ліміт розміру body.
- **Дедуплікація:** унікальний `monoId` захищає від повторних/конкурентних webhook deliveries. Зняття й комісія записуються в одній Prisma-транзакції.
- **HTML:** динамічні значення, що вставляються в Telegram HTML, проходять `escapeHtml`.
- **CSV:** текстові поля проходять `sanitizeForCsv`, зокрема category, description, workspace, type і source; поля також екрануються за правилами CSV. Експорт і backup містять приватні фінансові дані.
- **AI-провайдери:** текст повідомлень, історія радника й агреговані фінансові метрики можуть надсилатися до Gemini або Groq. Не передавайте дані, які не можна обробляти цими провайдерами.
- **Секрети:** `.env` не комітьте. Якщо Monobank URL із попередньої версії вже публікувався або був закомічений, відкличте старий URL/секрет і створіть новий.
- **Destructive actions:** `/reset` безповоротно видаляє всі транзакції та історію чату; перед підтвердженням переконайтеся, що backup збережений.

## Перевірки

Lint production і тестових модулів:

```powershell
npx eslint index.js fallback-ai.js export-helpers.js monthly-ai.js monthly-analytics.js stress-test.js check-gemini-models.js check-groq-models.js
```

Локальні security-перевірки без запитів до БД та AI API:

```powershell
node stress-test.js --security-only
```

Повний stress test:

```powershell
node stress-test.js
```

Повний режим робить read-запити до налаштованої PostgreSQL БД і реальні запити до Gemini/Groq, якщо відповідні ключі задані. Запускайте його лише на тестовому середовищі або з урахуванням вартості та лімітів API. Наразі в `package.json` окремого `test` script немає.

## Ліцензія

У `package.json` зазначено ліцензію ISC. Перед публічним розповсюдженням перевірте наявність `LICENSE`-файлу.
