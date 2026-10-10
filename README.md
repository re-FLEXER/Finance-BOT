# Financial Telegram Bot + AI + Monobank

Приватний фінансовий бот у Telegram для обліку доходів, витрат, заощаджень і боргів. Він приймає операції з повідомлень та Monobank, зберігає їх у PostgreSQL і формує звіти за допомогою ШІ.

## Архітектура

```mermaid
flowchart TD
    %% ВХІДНІ ДАНІ
    subgraph INPUTS["📥 1. Вхідні дані"]
        User["👤 Користувач у Telegram"]
        Mono["🏦 Monobank: транзакції"]
        Cron["⏰ Автоматичні задачі"]
    end

    %% СЕРВЕР І ЗАХИСТ
    subgraph CORE["🛡️ 2. Сервер і захист"]
        Server["🚀 Express + Telegraf"]
        Security{"🔐 Перевірка доступу та секрету вебхука"}
    end

    %% ОБРОБКА ОПЕРАЦІЙ І ЗАПИТІВ
    subgraph ENGINE["🧠 3. Обробка та ШІ"]
        Router{"🔀 Визначення дії"}
        Withdraw["🏦 Переказ зі збережень на картку (/withdraw)"]
        AI_Module["🤖 Модуль ШІ з автоматичним перемиканням"]
        Gemini["🟢 Gemini 3.5 Flash: основний"]
        Groq["🟠 Groq GPT-OSS-120B: резервний"]
        SaveFirst["💾 Базовий запис транзакції"]
        AsyncAI["⚡ setImmediate: AI-класифікація"]
        Notify["✏️ Оновлення запису та повідомлення"]
    end

    %% ЗБЕРІГАННЯ ДАНИХ
    subgraph STORAGE["🗄️ 4. Збереження"]
        Prisma["💎 Prisma ORM"]
        DB[("🛢️ PostgreSQL / Supabase")]
        Stats["🧮 stats-engine.js: єдине ядро капіталу та залишків"]
    end

    User -->|Команди та повідомлення| Server
    Mono -->|Сповіщення вебхуком| Server
    Cron -->|Запуск за розкладом| Server

    Server --> Security
    Security -->|Дозволено| Router
    Server -->|Monobank webhook| SaveFirst
    SaveFirst -->|Записано| DB
    SaveFirst -->|Негайно 200 OK| Mono
    SaveFirst -->|Фонове збагачення| AsyncAI
    AsyncAI --> AI_Module
    AI_Module --> Gemini
    Gemini -.->|Помилка запиту| Groq
    AsyncAI -->|Оновити категорію та простір| DB
    AsyncAI --> Notify
    Notify -->|Кнопка уточнення| User
    Router -->|Зняття зі збережень| Withdraw
    Router -->|Аналіз витрат або чат| AI_Module
    AI_Module -->|Результат аналізу| Router

    Withdraw --> Prisma
    Router -->|Запис операції| Prisma
    Prisma --> DB
    DB --> Stats
    Stats -->|Єдині залишки й капітал| Router
```

### Як це працює

- Команди та фінансові дані доступні власнику лише в приватному чаті; інші приватні звернення відхиляються, а групові повідомлення ігноруються.
- Бот визначає дію: записати операцію, звірити баланс або відповісти як фінансовий радник.
- `/withdraw <сума> [опис]` переносить суму зі збережень на картку: залишок картки зростає, заощадження зменшуються, загальний капітал не змінюється.
- Вебхук Monobank перевіряє `MONO_SECRET` і `monoId`. Для звичайної транзакції спершу створюється базовий запис, після чого надсилається `200 OK`; AI-класифікація працює у фоні через `setImmediate`, оновлює категорію/простір і надсилає повідомлення з кнопкою `[✏️ Уточнити]`. Зняття готівки та комісія записуються одним атомарним пакетом.
- `stats-engine.js` є єдиним джерелом розрахунків залишків і чистого капіталу: картка + готівка + заощадження + кошти до повернення − власні борги.
- Gemini є основним ШІ-провайдером, Groq — резервним. Будь-яка помилка запиту до Gemini журналюється перед перемиканням на Groq.
- Prisma зберігає операції, історію розмови й відкладені звіти у PostgreSQL; JSON-бекапи включають усі таблиці та soft-deleted записи.

## Актуальна логіка

- **Грошова точність:** суми зберігаються у PostgreSQL як `DECIMAL(20,2)`, а проміжні підсумки статистики рахуються в копійках.
- **Monobank:** валютні операції конвертуються в гривню за `rateCross` або середнім `rateBuy`/`rateSell` (кеш 5 хвилин); дата береться з `statementItem.time`, повторні `monoId` не створюють дублів.
- **Класифікація:** звичайний текст може містити кілька фінансових дій; AI визначає тип, категорію, простір і джерело коштів. Якщо класифікація `/add` недоступна, запис зберігається як витрата в категорії «Загальне».
- **Обмеження AI-відповідей:** типи, простори та напрямки транзакцій перевіряються за контекстом операції перед збереженням.
- **Telegram webhook:** коли задано `RENDER_EXTERNAL_URL`, застосунок реєструє webhook із `TELEGRAM_WEBHOOK_SECRET`; команди дозволені лише власнику в приватному чаті.
- **Часовий пояс:** застосунок примусово встановлює `Europe/Kyiv` для дат і Cron-задач.
- **Звірка і заощадження:** `/sync`, `/setbalance` та `/setsavings` приймають десяткову крапку або кому; залишок картки допускає нуль і від’ємні суми.
- **Резервні копії:** `/reset` вимагає двоетапного підтвердження, надсилає власнику повний JSON-бекап і лише після успішного надсилання очищає три таблиці. Щотижневий Cron також надсилає всі три таблиці, зокрема soft-deleted записи.
- **Інші запобіжники:** Monobank-зняття та комісія зберігаються атомарно; помилки Telegraf і необроблені Promise rejection журналюються.

## Можливості бота

- Облік особистих і проєктних доходів/витрат, коштів на картці та готівкою, заощаджень, переказів, боргів і початкових балансів.
- Розпізнавання однієї або кількох фінансових операцій зі звичайного тексту, ручне додавання через `/add` та автоматичне зарахування Monobank webhook.
- Статистика, синхронізація балансу, скасування останньої операції та пакетів транзакцій.
- AI-радник зі збереженням історії чату; кнопка очищення історії доступна в Telegram. Режим радника автоматично завершується після 20 хвилин бездіяльності.
- Кнопка `[✏️ Уточнити]` у сповіщенні про транзакцію дає змогу змінити її опис і повторно класифікувати запис.
- Щоденний звіт, місячний AI-аудит, CSV-експорт і щотижневий повний JSON-бекап у Telegram.
- Доступ до команд обмежений власником бота.

## Технологічний стек

| Частина | Технологія |
| --- | --- |
| Середовище виконання | Node.js v24 |
| Сервер і Telegram | Express, Telegraf |
| Доступ до даних | Prisma ORM |
| База даних | PostgreSQL, зокрема Supabase |
| Основний ШІ-провайдер | Gemini `gemini-3.5-flash` |
| Резервний ШІ-провайдер | Groq SDK, `openai/gpt-oss-120b` |
| Автоматизація | `node-cron` |
| Часовий пояс | `Europe/Kyiv` (`TZ`) |

## Команди Telegram

| Команда | Призначення |
| --- | --- |
| `/start` | Привітання власника та підказка команд `/help` і `/stats`. |
| `/help`, `/commands` | Показати команди. |
| `/stats` | Показати баланс, доходи, витрати, заощадження й борги. |
| `/setbalance <сума>` | Встановити початковий баланс картки. |
| `/sync <сума>` | Звірити баланс бота з фактичним залишком картки. |
| `/setsavings <сума>` | Синхронізувати загальну суму заощаджень. |
| `/withdraw <сума> [опис]`, `/withdrawsavings` | Переказати кошти зі збережень на картку без зміни загального капіталу. |
| `/debt <сума> <ім'я>` | Записати борг, який ви взяли. |
| `/lend <сума> <ім'я>` | Записати гроші, позичені іншій людині. |
| `/paydebt <сума>` | Записати погашення власного боргу. |
| `/getdebt <сума>` | Записати повернення позичених вам грошей. |
| `/undo` | Позначити останню транзакцію або її пакет як видалені. |
| `/reset` | Після двоетапного підтвердження `ОЧИСТИТИ ДАНІ` надіслати JSON-бекап і очистити транзакції, історію чату та чергу звітів. |
| `/advice`, `/advisor`, `/ask` | Увійти в режим AI-радника. |
| `/endadvice`, `/exit`, `/stop`, `/off` | Завершити режим AI-радника. |
| `/add <сума> <опис>` | Додати операцію; AI визначає її тип, категорію та простір. Якщо AI недоступний, записується витрата. |
| `/monthly` | Сформувати місячний фінансовий аудит. |
| `/export` | Експортувати всю історію транзакцій у CSV. |
| `/export month` | Експортувати поточний місяць у CSV. |

`/start` вітає власника; `/help` і `/commands` показують довідку. Команди завершення режиму радника: `/endadvice`, `/exit`, `/stop`, `/off`. Звичайний текст розбирається як транзакція, звірка балансу або запит до AI-радника; у режимі радника текст не записується як транзакція.

## Модулі та дані

| Шлях | Відповідальність |
| --- | --- |
| `index.js` | Express/Telegraf, allowlist, команди, webhook-и, Prisma-записи, cron-задачі й HTTP server. |
| `fallback-ai.js` | Gemini/Groq failover із опціональним JSON-режимом; повторні спроби для звітів. Відповіді проходять контекстну валідацію в `index.js`. |
| `stats-engine.js` | Єдине ядро розрахунків капіталу, залишків, заощаджень та боргів з єдиним екземпляром `PrismaClient`. |
| `monthly-analytics.js` | Агрегація показників, боргів і категорій для місячного звіту. |
| `monthly-ai.js` | Формування запиту до AI-аудитора й обробка JSON-відповіді. |
| `export-helpers.js` | Формування CSV-експорту, захист комірок від formula injection і створення повних JSON-дампів БД. |
| `prisma/schema.prisma` | PostgreSQL-моделі та constraints. |
| `prisma/migrations/` | PostgreSQL baseline, unique constraint для `monoId` і перехід суми до `DECIMAL(20,2)`. |
| `regression-test.js`, `test-harness.js` | Регресійні перевірки в ізольованому harness із заміненими БД, Telegram та AI-запитами. |
| `stress-test.js` | DB/API stress перевірки та локальні security-тести. |

У Prisma є три моделі:

- `Transaction`: тип, сума, категорія, опис, простір, джерело, soft-delete, група пакета й унікальний nullable `monoId`.
- `ChatHistory`: коротка історія повідомлень користувача та AI.
- `ReportQueue`: збережені звіти, які не вдалося згенерувати під час першої спроби.

## Вимоги та конфігурація

- Node.js v24 та npm.
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
TELEGRAM_WEBHOOK_SECRET=use_a_second_unique_random_secret_of_at_least_32_characters
TZ=Europe/Kyiv
PORT=3000
# Необов'язково: лише для ручного прикладу реєстрації Monobank webhook у test-api.http
MONO_API_TOKEN=your_monobank_personal_api_token
```

`MONO_SECRET` згенеруйте як випадкове значення щонайменше 32 символи, наприклад `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Не використовуйте буквальний placeholder із прикладу.
`TELEGRAM_WEBHOOK_SECRET` згенеруйте окремо таким самим способом. Не використовуйте один секрет для Telegram і Monobank. `MONO_API_TOKEN` потрібний лише якщо вручну виконуєте запит реєстрації webhook-а у `test-api.http`; ніколи не додавайте його до Git.

| Змінна | Призначення |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot API token; також входить до шляху Telegram webhook. |
| `MY_CHAT_ID` | Числовий Telegram ID власника, єдиний дозволений користувач бота. |
| `DATABASE_URL` | URL PostgreSQL для runtime-запитів Prisma; може бути pooler URL. |
| `DIRECT_URL` | Пряме PostgreSQL-підключення для Prisma migrations. |
| `GEMINI_API_KEY` | API key основного AI-провайдера. |
| `GROQ_API_KEY` | API key резервного AI-провайдера. |
| `MONO_SECRET` | Випадковий URL-секрет Monobank webhook, мінімум 32 символи. |
| `TELEGRAM_WEBHOOK_SECRET` | Окремий секрет заголовка Telegram webhook, мінімум 32 символи; потрібний на Render. |
| `MONO_API_TOKEN` | Необов'язковий особистий API token Monobank тільки для ручного REST Client запиту. |
| `TZ` | Часовий пояс процесу для обчислення дат і Cron-задач; застосунок встановлює `Europe/Kyiv`. |
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

Health check: `http://localhost:3000/ping`; `200 OK` означає, що база доступна. Якщо задано `RENDER_EXTERNAL_URL`, також має бути успішно зареєстровано Telegram webhook; до його налаштування endpoint повертає `503`. Без `RENDER_EXTERNAL_URL` webhook-ready перевірка не блокує локальний запуск. HTTP-приклади webhook-ів є у `test-api.http`; тестовий Monobank ID з префіксом `test_` не записується в БД. REST Client підставляє `MONO_SECRET` і за потреби `MONO_API_TOKEN` із локального `.env`.

### Міграції PostgreSQL

Для порожньої PostgreSQL бази `npx prisma migrate deploy` створює схему з baseline і додає unique index `Transaction_monoId_key`.

Міграція `20261008000100_amount_decimal` переводить `Transaction.amount` із `DOUBLE PRECISION` у `DECIMAL(20,2)` та округлює вже збережені значення до копійок. Перед застосуванням до наявної БД зробіть backup. Build-команда Render запускає `prisma generate` перед міграціями; після ручного `migrate deploy` виконайте `npx prisma generate` перед запуском застосунку.

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
4. Додайте `BOT_TOKEN`, `MY_CHAT_ID`, `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MONO_SECRET`, `TELEGRAM_WEBHOOK_SECRET` і `TZ=Europe/Kyiv` у Render Environment.
5. Для наявної БД виконайте одноразовий baseline resolve до першого deploy з міграціями; Render build не повинен виконувати його автоматично.
6. Переконайтеся, що Telegram webhook зареєстрований на `https://<service>.onrender.com/telegram/<BOT_TOKEN>` з окремим secret token у заголовку.
7. У Monobank задайте webhook URL `https://<service>.onrender.com/monobank/<MONO_SECRET>`.

## Фонові задачі

Cron-задачі працюють у процесі Node.js за часовим поясом `Europe/Kyiv`:

| Розклад | Задача |
| --- | --- |
| Щодня о 23:54 | Розрахунок і відправка щоденного звіту; при недоступності AI звіт ставиться в `ReportQueue`. |
| Кожні 30 хвилин | Повторна обробка звітів `PENDING`. |
| В останній день місяця о 23:55 | Місячний аудит. |
| Щонеділі о 23:00 | Повний JSON backup таблиць `Transaction`, `ChatHistory` і `ReportQueue` у Telegram, разом із soft-deleted записами. |

Це in-process scheduler, не зовнішній durable queue. Використовуйте один постійно запущений інстанс: кілька реплік можуть дублювати cron-роботу, а sleep/restart може відкласти її. Стан режиму радника та cooldown для alert також зберігаються в пам’яті процесу й губляться після рестарту.

## Безпека та посилення захисту

- **Telegram allowlist:** middleware звіряє `ctx.from.id` з `MY_CHAT_ID`; сторонні користувачі не отримують доступ до команд. Сповіщення про відмову та alert cooldown не замінюють rate limiting на рівні edge/proxy.
- **Telegram webhook:** перевіряються і секретний шлях, і `X-Telegram-Bot-Api-Secret-Token`; якщо задано `RENDER_EXTERNAL_URL`, при старті застосунок відхиляє секрет коротший за 32 символи та позначає webhook неготовим, якщо реєстрація Telegram не вдалася. Команди приймаються тільки від власника в приватному чаті. Не публікуйте URL webhook.
- **Monobank webhook:** `MONO_SECRET` має щонайменше 32 символи та порівнюється constant-time; GET-маршрут відповідає `200` для перевірки URL під час реєстрації. Секрет є bearer credential у URL; URL може потрапити до access logs. Monobank-підпис тіла в цьому endpoint не перевіряється, тому застосовуйте унікальний секрет і ротайте його при витоку. Після перевірки payload і дубля звичайна транзакція спершу зберігається в БД, а `200 OK` надсилається до AI-аналізу; категоризація та Telegram-сповіщення виконуються асинхронно.
- **Webhook payload:** перевіряються ID, ціла сума в мінорних одиницях, валюта, дата й розмір тексту; для іноземної валюти застосовується курс Monobank, доступний під час обробки webhook-а.
- **Дедуплікація:** унікальний `monoId` захищає від повторних/конкурентних webhook deliveries. Зняття й комісія записуються в одній Prisma-транзакції.
- **HTML:** динамічні значення, що вставляються в Telegram HTML, проходять `escapeHtml`.
- **Бекапи й CSV:** CSV-поля проходять `sanitizeForCsv`; JSON-бекап зберігає повні записи усіх трьох таблиць, включно з `toSource`, `monoId`, `batchId` та `is_deleted`. Файли містять приватні фінансові дані — обмежте доступ до Telegram-чату та завантажених копій.
- **AI-провайдери:** текст повідомлень, історія радника й агреговані фінансові метрики можуть надсилатися до Gemini або Groq. Не передавайте дані, які не можна обробляти цими провайдерами.
- **Секрети й Git:** `.gitignore` виключає `.env`, `.zip`-архіви та SQLite-артефакти. Ротуйте всі ключі й токени (`BOT_TOKEN`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MONO_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `MONO_API_TOKEN`, облікові дані БД), якщо вони потрапили до Git, логів або стороннього доступу.
- **Destructive actions:** перед `/reset` бот створює та надсилає JSON-дамп усіх таблиць у приватний чат; очищення виконується лише після успішного надсилання копії.

## Перевірки

Lint production і тестових модулів:

```powershell
npx eslint index.js fallback-ai.js export-helpers.js monthly-ai.js monthly-analytics.js stats-engine.js regression-test.js test-harness.js stress-test.js check-gemini-models.js check-groq-models.js
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

Ізольований набір регресійних перевірок без реальної БД, Telegram та AI API:

```powershell
node regression-test.js
```

Набір перевіряє сценарії введення сум, доступу та webhook-ів, класифікації транзакцій, редагування, статистики й доступності сервера.

Перевірка доступності моделей і реальний короткий запит до Gemini:

```powershell
node check-gemini-models.js
```

Скрипт показує моделі, доступні ключу, викликає `gemini-3.5-flash` із тайм-аутом 30 секунд і виводить повідомлення, статус та подробиці помилки. Його можна запустити локально або в оболонці Render із налаштованим `GEMINI_API_KEY`; запит звертається до зовнішнього API.

## Ліцензія

У `package.json` зазначено ліцензію ISC. Перед публічним розповсюдженням перевірте наявність `LICENSE`-файлу.
