# Financial Telegram Bot

Telegram-бот для особистого фінансового обліку з підтримкою картки та готівки, інтеграцією з Monobank, AI-класифікацією транзакцій і фінансовою аналітикою.

Бот приймає текстові повідомлення як описи фінансових операцій або запитання до AI-радника. Дані зберігаються у PostgreSQL через Prisma. HTTP-сервер приймає Telegram і Monobank webhook-и та надає health-check для Render.

## Можливості

- Облік доходів, витрат, заощаджень, переказів між карткою та готівкою, боргів і початкових балансів.
- Автоматична класифікація текстових повідомлень і транзакцій Monobank через Gemini з резервним провайдером Groq.
- Синхронізація балансу, статистика та скасування останньої операції.
- AI-радник із короткою історією розмови.
- Місячний AI-аудит, щоденний звіт і експорт транзакцій у CSV.
- Щотижневий CSV-бекап, який надсилається в Telegram.
- Доступ до команд бота обмежений Telegram ID із `MY_CHAT_ID`.

## Архітектура

```mermaid
flowchart TD
    User[Telegram user] -->|Webhook| Express[Express server]
    Mono[Monobank] -->|Webhook| Express
    Express --> Bot[Telegraf handlers]
    Bot --> Services[AI, analytics, export helpers]
    Bot --> Prisma[Prisma Client]
    Services --> Prisma
    Prisma --> DB[(PostgreSQL)]
    Cron[node-cron jobs] --> Services
    Cron --> Bot
    AI[Gemini / Groq APIs] <--> Services
```

`index.js` збирає застосунок: створює Express, Telegraf і Prisma-клієнти, реєструє маршрути та команди, запускає cron-задачі й HTTP-сервер. Telegram webhook автоматично реєструється під час запуску, якщо встановлено `RENDER_EXTERNAL_URL`.

## Команди бота

| Команда | Призначення |
| --- | --- |
| `/start` | Перевірити, що бот працює. |
| `/help`, `/commands` | Показати список команд. |
| `/stats` | Показати баланс, доходи, витрати, заощадження та борги. |
| `/setbalance <сума>` | Встановити початковий баланс картки. |
| `/sync <сума>` | Вирівняти баланс у боті з фактичним балансом картки. |
| `/setsavings <сума>` | Синхронізувати загальну суму заощаджень. |
| `/debt <сума> <ім'я>` | Записати взятий у борг (пасив). |
| `/lend <сума> <ім'я>` | Записати гроші, позичені іншій людині (актив). |
| `/paydebt <сума>` | Записати погашення власного боргу. |
| `/getdebt <сума>` | Записати повернення позичених вам грошей. |
| `/undo` | Позначити останню транзакцію або її пакет як видалені. |
| `/reset` | Запустити двоетапне очищення транзакцій та історії чату. Потребує введення `ОЧИСТИТИ ДАНІ`. |
| `/advice`, `/advisor`, `/ask` | Увійти в режим AI-радника. |
| `/endadvice`, `/exit`, `/stop`, `/off` | Завершити режим AI-радника. |
| `/add <сума> <опис>` | Додати витрату вручну з AI-класифікацією опису. |
| `/monthly` | Згенерувати місячний фінансовий аудит. |
| `/export` | Експортувати всю історію транзакцій у CSV. |
| `/export month` | Експортувати транзакції поточного місяця у CSV. |

Також бот класифікує звичайний текст: фінансову операцію записує як транзакцію, запитання передає AI-раднику. У режимі радника повідомлення не класифікуються як транзакції. Сесію завершує тайм-аут неактивності у 20 хвилин.

## Структура модулів

| Файл | Відповідальність |
| --- | --- |
| `index.js` | Точка входу; Telegram-команди й обробники; Express-маршрути `/ping`, `/monobank/:secret` і Telegram webhook; статистика, AI-радник, звіти, cron-задачі та запуск сервера. |
| `fallback-ai.js` | Генерація тексту через Gemini із резервним переходом на Groq; повторні спроби для AI-запитів. |
| `monthly-analytics.js` | Агрегація метрик поточного/попереднього місяця, боргів і топ-категорій через Prisma. |
| `monthly-ai.js` | Формування промпту й обробка JSON-відповіді AI-аудитора. |
| `export-helpers.js` | Отримання транзакцій і формування CSV-файлу. |
| `prisma/schema.prisma` | Моделі `Transaction`, `ChatHistory`, `ReportQueue` і налаштування PostgreSQL. |
| `prisma/migrations/` | Версіоновані міграції схеми БД. |

## Вимоги

- Node.js 20 або новіший LTS і npm.
- PostgreSQL.
- Telegram-бот, створений через [@BotFather](https://t.me/BotFather).
- API-ключі Gemini та Groq для AI-функцій і резервного провайдера.
- Публічний HTTPS URL для webhook-ів у production.

## Налаштування середовища

Створіть локальний `.env` у корені проєкту. Не додавайте його до Git.

```dotenv
BOT_TOKEN=telegram_bot_token
MY_CHAT_ID=123456789
DATABASE_URL=postgresql://user:password@host:5432/database?schema=public
DIRECT_URL=postgresql://user:password@host:5432/database?schema=public
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
MONO_SECRET=generate_a_random_secret_at_least_32_characters
PORT=3000
```

| Змінна | Призначення |
| --- | --- |
| `BOT_TOKEN` | Токен Telegram-бота; використовується Telegraf і в шляху Telegram webhook. |
| `MY_CHAT_ID` | Числовий Telegram ID власника. Інші користувачі не проходять middleware allowlist. |
| `DATABASE_URL` | URL підключення Prisma до PostgreSQL. |
| `DIRECT_URL` | Пряме підключення PostgreSQL, яке Prisma використовує для міграцій. |
| `GEMINI_API_KEY` | Основний провайдер AI. |
| `GROQ_API_KEY` | Резервний AI-провайдер. |
| `PORT` | HTTP-порт. На Render значення надає платформа; локально типовий порт — `3000`. |
| `RENDER_EXTERNAL_URL` | Системна змінна Render. Якщо вона доступна, застосунок автоматично реєструє Telegram webhook. Не задавайте вручну без потреби. |
| `MONO_SECRET` | Випадковий секрет довжиною щонайменше 32 символи; захищає URL webhook Monobank. Зберігайте його лише в `.env` та налаштуваннях середовища. |

Для Render PostgreSQL використовуйте URL-и, які надає база. Якщо застосовуєте пулер, задайте його адресу у `DATABASE_URL`, а пряме підключення для міграцій — у `DIRECT_URL`.

## Локальний запуск

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm start
```

Перевірте сервер за адресою `http://localhost:3000/ping`: очікувана відповідь — `OK`. Для локального тестування Monobank webhook є приклад у `test-api.http`; тестовий ID із префіксом `test_` лише підтверджується й не записується в БД.

Для порожньої PostgreSQL БД застосуйте міграції звичайною командою `npx prisma migrate deploy`. Для вже заповненої БД, створеної до впровадження PostgreSQL migrations, спочатку звірте її схему з `prisma/schema.prisma`, одноразово позначте baseline як застосований командою `npx prisma migrate resolve --applied 20260928000000_baseline_postgresql`, а потім виконайте `npx prisma migrate deploy`. Не запускайте baseline resolve на порожній БД.

## Розгортання на Render

### 1. Підготуйте PostgreSQL

Створіть PostgreSQL database на Render або підготуйте сумісну зовнішню базу. Скопіюйте URL-и підключення для `DATABASE_URL` і `DIRECT_URL`. Застосунок використовує міграції з `prisma/migrations/`.

### 2. Створіть Web Service

У Render створіть **New > Web Service** і під’єднайте GitHub-репозиторій.

Вкажіть:

| Налаштування Render | Значення |
| --- | --- |
| Runtime | Node |
| Build Command | `npm ci && npx prisma generate && npx prisma migrate deploy` |
| Start Command | `npm start` |
| Health Check Path | `/ping` |

Якщо проєкт лежить у корені репозиторію, залиште Root Directory типовим.

### 3. Додайте Environment Variables

У розділі **Environment** сервісу задайте `BOT_TOKEN`, `MY_CHAT_ID`, `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`, `GROQ_API_KEY` і `MONO_SECRET`. Для вже наявної БД виконайте одноразовий baseline resolve до першого deploy із новими міграціями. Не задавайте `PORT` вручну: Render встановлює його під час запуску. `RENDER_EXTERNAL_URL` Render надає автоматично.

### 4. Перевірте запуск і webhook-и

Після успішного deploy відкрийте `https://<ім'я-сервісу>.onrender.com/ping`. Під час запуску застосунок автоматично реєструє Telegram webhook на `RENDER_EXTERNAL_URL` із шляхом `/telegram/<BOT_TOKEN>`.

Webhook Monobank має вказувати на `https://<ім'я-сервісу>.onrender.com/monobank/<MONO_SECRET>`. Endpoint перевіряє секрет у URL і відхиляє неавторизовані запити; Monobank не підписує тіло webhook у цій інтеграції, тому використовуйте довгий випадковий секрет і не публікуйте URL.

## Фонові задачі

Усі cron-задачі запускаються всередині процесу Web Service за часовим поясом `Europe/Kyiv`:

- Щоденний фінансовий звіт — щодня о 23:54.
- Місячний AI-аудит — в останній день місяця о 23:55.
- Повторна обробка звітів зі статусом `PENDING` — кожні 30 хвилин.
- CSV-бекап історії — щонеділі о 23:00.

Оскільки задачі працюють у процесі вебсервісу, він має залишатися запущеним. На плані з автоматичним засинанням звіти можуть пропускатися, а кілька інстансів можуть виконувати одну задачу повторно. Для надійного розкладу використовуйте always-on інстанс і один екземпляр сервісу або винесіть задачі в окремий worker/scheduler.

## Безпека та дані

- Не комітьте `.env`, токени бота, API-ключі або URL-и бази. `.env` уже виключений у `.gitignore`.
- Бот зберігає фінансові записи й історію AI-чату в PostgreSQL. Команда `/reset` видаляє транзакції та історію чату; перед використанням переконайтеся, що маєте потрібні резервні копії.
- Telegram webhook наразі використовує `BOT_TOKEN` у шляху; окремий `secret_token` для перевірки webhook не налаштований.
- Monobank webhook використовує `MONO_SECRET` у URL; секрет із попереднього `test-api.http` був прибраний, але оскільки він уже був у Git-історії, замініть його в налаштуваннях Monobank та середовищі сервера.
- CSV-експорт містить описи й категорії транзакцій. Обробляйте такі файли як приватні фінансові дані.

## Ліцензія

У `package.json` вказана ліцензія ISC. Перевірте наявність відповідного `LICENSE`-файлу в репозиторії перед публічним розповсюдженням.