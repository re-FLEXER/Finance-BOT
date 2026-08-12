require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Сховище для тимчасових даних "Уточнити"
const userStates = {};

// --- ТЕЛЕГРАМ ВЕБХУК НАЛАШТУВАННЯ ---
const WEBHOOK_PATH = `/telegram/${process.env.BOT_TOKEN}`;
app.post(WEBHOOK_PATH, (req, res) => {
    bot.handleUpdate(req.body, res);
});

// --- СТАТИСТИКА ТА РОЗРАХУНКИ ---
const getStatsData = async () => {
    const allTransactions = await prisma.transaction.findMany();
    
    let initBalance = 0;
    let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0; // Мої борги та їх погашення
    let oweMeTotal = 0, getDebtTotal = 0; // Борги мені та їх повернення

    allTransactions.forEach(t => {
        if (t.type === 'init_balance') {
            initBalance += t.amount;
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') wIncome += t.amount;
            if (t.type === 'expense') wExpense += t.amount;
        } else {
            if (t.type === 'income') pIncome += t.amount;
            if (t.type === 'expense') pExpense += t.amount;
            if (t.type === 'saving') pSaving += t.amount;
            if (t.type === 'i_owe') iOweTotal += t.amount;
            if (t.type === 'pay_debt') payDebtTotal += t.amount;
            if (t.type === 'owe_me') oweMeTotal += t.amount;
            if (t.type === 'get_debt') getDebtTotal += t.amount;
        }
    });

    const workProfit = wIncome - wExpense;
    
    // Поточний стан боргів (Скільки залишилось виплатити)
    const currentIOwe = iOweTotal - payDebtTotal;
    const currentOweMe = oweMeTotal - getDebtTotal;

    // Реальний залишок = Початковий залишок + Доходи - Витрати - Збереження - Дав у борг (заморожено) + Мені повернули борг - Я віддав свій борг (витрата)
    const personalBalance = initBalance + pIncome - pExpense - pSaving - oweMeTotal + getDebtTotal - payDebtTotal;

    return {
        initBalance, pIncome, pExpense, pSaving, wIncome, wExpense,
        currentIOwe, currentOweMe, workProfit, personalBalance
    };
};

const showStats = async (ctx) => {
    try {
        const stats = await getStatsData();
        const message = `📊 <b>ФІНАНСОВА СТАТИСТИКА</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `🏁 <b>Початковий залишок:</b> ${stats.initBalance} грн\n` +
                        `👤 <b>ОСОБИСТИЙ БЮДЖЕТ</b>\n` +
                        `🟢 <b>Доходи:</b> ${stats.pIncome} грн\n` +
                        `🔴 <b>Витрати:</b> ${stats.pExpense} грн\n` +
                        `🟡 <b>Збереження:</b> ${stats.pSaving} грн\n` +
                        `🤝 <b>Мені винні (Актив):</b> ${stats.currentOweMe} грн\n` +
                        `⚠️ <b>Я винен (Пасив):</b> ${stats.currentIOwe} грн\n` +
                        `💳 <b>РЕАЛЬНИЙ ЗАЛИШОК:</b> ${stats.personalBalance} грн\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💼 <b>ПРОЄКТИ ТА ФРИЛАНС</b>\n` +
                        `🟢 <b>Доходи:</b> ${stats.wIncome} грн\n` +
                        `🔴 <b>Витрати:</b> ${stats.wExpense} грн\n` +
                        `📈 <b>Чиста рентабельність:</b> ${stats.workProfit} грн`;
        
        await ctx.replyWithHTML(message);
    } catch (error) {
        console.error(error);
        await ctx.reply('Вибач, сталася помилка при зчитуванні бази.');
    }
};

// --- КОМАНДИ БОТА ---

bot.start((ctx) => ctx.reply('Привіт! Бот активний. Введи /help для списку команд або /stats для перегляду балансу.'));

const helpMessage = `
ℹ️ <b>СПИСОК ДОСТУПНИХ КОМАНД</b>
━━━━━━━━━━━━━━━━━━

📊 <b>Основи та Статистика:</b>
• /stats — Переглянути фінансову статистику та реальний залишок.
• /setbalance <code>&lt;сума&gt;</code> — Встановити початковий залишок (точка відліку на картці).

🤝 <b>Модуль Боргів (Debt Tracker):</b>
• /debt <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти взяв у борг (Пасив).
• /lend <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти дав у борг (Актив).
• /paydebt <code>&lt;сума&gt;</code> — Погасити частину/весь свій борг (Зменшує залишок і борг).
• /getdebt <code>&lt;сума&gt;</code> — Зафіксувати, що тобі повернули борг (Збільшує залишок).

🔄 <b>Керування даними:</b>
• /reset — Повністю очистити базу даних (з підтвердженням).

💡 <b>ШІ-Радник:</b>
• Пиши будь-яке текстове повідомлення-запит і ШІ дасть пораду на базі твого поточного бюджету та боргів.
`;

bot.command(['help', 'commands'], async (ctx) => {
    await ctx.replyWithHTML(helpMessage);
});

// 1. Встановлення початкового залишку
bot.command('setbalance', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const amount = parseFloat(args[1]);
    if (isNaN(amount)) {
        return ctx.reply('Будь ласка, вкажи суму правильно. Наприклад: /setbalance 450.60');
    }
    
    // Видаляємо старі записи початкового балансу, щоб не плюсувалися
    await prisma.transaction.deleteMany({ where: { type: 'init_balance' } });
    
    await prisma.transaction.create({
        data: { type: 'init_balance', amount: amount, category: 'Початковий залишок', description: 'Задано вручну', workspace: 'Особисте' }
    });
    
    await ctx.reply(`✅ Початковий залишок успішно зафіксовано: ${amount} грн. Це твоя точка відліку.`);
});

// 2. Скидання бази даних
bot.command('reset', async (ctx) => {
    await ctx.reply('⚠️ Ти дійсно хочеш повністю очистити всі транзакції та борги?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Так, очистити все', 'confirm_reset'), Markup.button.callback('❌ Скасувати', 'cancel_reset')]
    ]));
});

bot.action('confirm_reset', async (ctx) => {
    await prisma.transaction.deleteMany({});
    await ctx.editMessageText('🗑 База даних повністю очищена! Вкажи новий початковий залишок через /setbalance.');
});

bot.action('cancel_reset', async (ctx) => {
    await ctx.editMessageText('Очищення скасовано.');
});

// 3. Борговий модуль (Фіксація та Погашення)
bot.command('debt', async (ctx) => {
    const text = ctx.message.text.replace('/debt', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /debt <сума> <хто дав>. Наприклад: /debt 500 Петро');

    await prisma.transaction.create({
        data: { type: 'i_owe', amount, category: 'Пасив', description: `Взято у борг від ${name}`, workspace: 'Особисте' }
    });
    await ctx.reply(`🤝 Зафіксовано пасив: ти винен ${amount} грн (${name}).`);
});

bot.command('lend', async (ctx) => {
    const text = ctx.message.text.replace('/lend', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /lend <сума> <кому дав>. Наприклад: /lend 200 Олег');

    await prisma.transaction.create({
        data: { type: 'owe_me', amount, category: 'Актив', description: `Дано у борг ${name}`, workspace: 'Особисте' }
    });
    await ctx.reply(`🤝 Зафіксовано актив (витрата з залишку): тобі винні ${amount} грн (${name}).`);
});

bot.command('paydebt', async (ctx) => {
    const text = ctx.message.text.replace('/paydebt', '').trim();
    const amount = parseFloat(text);
    if (isNaN(amount)) return ctx.reply('Формат: /paydebt <сума>. Наприклад: /paydebt 5000');

    await prisma.transaction.create({
        data: { type: 'pay_debt', amount, category: 'Погашення', description: `Віддав частину боргу`, workspace: 'Особисте' }
    });
    await ctx.reply(`💸 Записано: ти погасив ${amount} грн свого боргу. Залишок на картці зменшено.`);
});

bot.command('getdebt', async (ctx) => {
    const text = ctx.message.text.replace('/getdebt', '').trim();
    const amount = parseFloat(text);
    if (isNaN(amount)) return ctx.reply('Формат: /getdebt <сума>. Наприклад: /getdebt 2000');

    await prisma.transaction.create({
        data: { type: 'get_debt', amount, category: 'Повернення', description: `Мені повернули борг`, workspace: 'Особисте' }
    });
    await ctx.reply(`📥 Записано: тобі повернули ${amount} грн боргу. Залишок на картці збільшено.`);
});

bot.command('stats', showStats);

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Обробка режиму уточнення (Додано можливість ШІ змінювати тип транзакції на борги)
    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Користувач уточнив транзакцію: "${userText}". 
            Визнач нову type ("income", "expense", "saving", "pay_debt", "get_debt", "i_owe", "owe_me"), category та workspace ("Проєкт" або "Особисте").
            Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;
            
            const result = await model.generateContent(prompt);
            const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

            await prisma.transaction.update({
                where: { id: txId },
                data: { type: aiData.type, category: aiData.category, workspace: aiData.workspace, description: userText }
            });

            return ctx.reply('✅ Транзакцію та її тип успішно оновлено!');
        } catch (e) {
            return ctx.reply('Не вдалося оновити транзакцію.');
        }
    }

    // AI Радник
    const waitMsg = await ctx.reply('⏳ Аналізую ваші фінанси...');
    try {
        const stats = await getStatsData();
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const advisorPrompt = `
Ти — фінансовий ментор.
Поточний стан користувача:
- Початковий залишок: ${stats.initBalance} грн.
- Вільні кошти (Реальний залишок): ${stats.personalBalance} грн.
- Збереження: ${stats.pSaving} грн.
- Активні борги користувача (він винен): ${stats.currentIOwe} грн.
- Йому винні: ${stats.currentOweMe} грн.

Запит користувача: "${userText}"
Завдання: Дай коротку стратегічну пораду. Враховуй борги! Якщо користувач хоче зробити велику витрату, але має активні борги, обов'язково нагадай про них.
Правило: Використовуй тільки базовий HTML (<b>, <i>).
`;

        const adviceResult = await model.generateContent(advisorPrompt);
        let safeResponse = adviceResult.response.text()
            .replace(/<h[1-6]>/g, '<b>')
            .replace(/<\/h[1-6]>/g, '</b>\n')
            .replace(/\*/g, '');

        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.replyWithHTML(`🎩 <b>ТВІЙ РАДНИК:</b>\n\n${safeResponse}`);
    } catch (err) {
        console.error(err);
        await ctx.reply('Помилка генерації поради ШІ.');
    }
});

// Кнопка Уточнити
bot.action(/edit_(\d+)/, async (ctx) => {
    const txId = parseInt(ctx.match[1]);
    userStates[ctx.from.id] = { isEditing: true, txId: txId };
    await ctx.reply('Введіть новий опис. Якщо це сплата боргу, так і напишіть (наприклад: "погасив борг Сані"):');
});

// --- ВЕБХУК МОНОБАНКУ ---
app.post('/monobank', async (req, res) => {
    res.status(200).send('OK');
    const data = req.body.data;
    if (!data || !data.statementItem) return;

    const item = data.statementItem;
    const amount = Math.abs(item.amount) / 100;
    const description = item.description || 'Транзакція Monobank';
    const isIncome = item.amount > 0;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Проаналізуй транзакцію з Монобанку. 
        Сума: ${amount}, Опис: "${description}", Зарахування: ${isIncome}.
        
        Визнач type:
        - Поповнення банки/депозиту/між власними рахунками -> "saving"
        - Прибуток/ЗП -> "income"
        - Покупка/Витрата -> "expense"
        - Якщо в описі чітко йдеться про повернення боргу ТОБІ -> "get_debt"
        - Якщо в описі йдеться про погашення ТВОГО боргу -> "pay_debt"
        
        Визнач category та workspace ("Проєкт" або "Особисте").
        Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;

        const result = await model.generateContent(prompt);
        const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

        const savedTx = await prisma.transaction.create({
            data: {
                type: aiData.type,
                amount: amount,
                category: aiData.category,
                description: description,
                workspace: aiData.workspace
            }
        });

        const msg = `🏦 <b>Monobank</b> | Автоматично\n\n` +
                    `📦 <b>Простір:</b> ${aiData.workspace}\n` +
                    `🏷 <b>Категорія:</b> ${aiData.category}\n\n` +
                    `💵 <b>Сума:</b> ${amount} грн\n` +
                    `📝 <b>Опис:</b> ${description}`;

        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Уточнити', `edit_${savedTx.id}`)]])
        });
    } catch (e) {
        console.error('Помилка обробки Монобанку:', e);
    }
});

// --- СТАРТ СЕРВЕРА ТА РЕЄСТРАЦІЯ ВЕБХУКУ ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Сервер працює на порту ${PORT}`);
    
    // Встановлюємо меню команд у Telegram
    try {
        await bot.telegram.setMyCommands([
            { command: 'stats', description: '📊 Фінансова статистика' },
            { command: 'setbalance', description: '💵 Встановити початковий залишок' },
            { command: 'debt', description: '🤝 Взяв у борг (Пасив)' },
            { command: 'lend', description: '🤝 Дав у борг (Актив)' },
            { command: 'paydebt', description: '💸 Віддав свій борг' },
            { command: 'getdebt', description: '📥 Мені повернули борг' },
            { command: 'help', description: 'ℹ️ Список усіх команд' },
            { command: 'reset', description: '⚠️ Очистити всі дані' }
        ]);
    } catch (err) {
        console.error('Помилка встановлення меню команд:', err);
    }

    if (process.env.RENDER_EXTERNAL_URL) {
        const fullWebhookUrl = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(fullWebhookUrl);
        console.log(`Telegram Webhook встановлено: ${fullWebhookUrl}`);
    }
});