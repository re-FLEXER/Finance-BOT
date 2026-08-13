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
    let initSaving = 0; // Початкові збереження (Банка до старту бота)
    let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0; 
    let oweMeTotal = 0, getDebtTotal = 0; 

    allTransactions.forEach(t => {
        if (t.type === 'init_balance') {
            initBalance += t.amount;
        } else if (t.type === 'init_saving') {
            initSaving += t.amount;
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
    
    const currentIOwe = iOweTotal - payDebtTotal;
    const currentOweMe = oweMeTotal - getDebtTotal;
    
    const totalSaving = initSaving + pSaving; // Всі гроші на банці

    // Реальний залишок на картці (не враховує initSaving, але віднімає поточні pSaving)
    const personalBalance = initBalance + pIncome - pExpense - pSaving - oweMeTotal + getDebtTotal - payDebtTotal;
    
    // Загальний капітал = Гроші на картці + Гроші на банці
    const totalCapital = personalBalance + totalSaving;

    return {
        initBalance, pIncome, pExpense, totalSaving, wIncome, wExpense,
        currentIOwe, currentOweMe, workProfit, personalBalance, totalCapital
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
                        `🟡 <b>Збереження (Банка):</b> ${stats.totalSaving} грн\n` +
                        `🤝 <b>Мені винні (Актив):</b> ${stats.currentOweMe} грн\n` +
                        `⚠️ <b>Я винен (Пасив):</b> ${stats.currentIOwe} грн\n` +
                        `💳 <b>РЕАЛЬНИЙ ЗАЛИШОК (Картка):</b> ${stats.personalBalance} грн\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💰 <b>ЗАГАЛЬНИЙ КАПІТАЛ:</b> ${stats.totalCapital} грн\n` +
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
• /stats — Переглянути фінансову статистику та загальний капітал.
• /setbalance <code>&lt;сума&gt;</code> — Встановити початковий залишок на картці.
• /setsavings <code>&lt;сума&gt;</code> — Встановити початкову суму на Банці (не мінусується з картки).
• /save <code>&lt;сума&gt;</code> — Відкласти поточні гроші в Банку (мінусується з картки).

🤝 <b>Модуль Боргів (Debt Tracker):</b>
• /debt <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти взяв у борг (Пасив).
• /lend <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти дав у борг (Актив).
• /paydebt <code>&lt;сума&gt;</code> — Погасити частину/весь свій борг.
• /getdebt <code>&lt;сума&gt;</code> — Зафіксувати, що тобі повернули борг.

🔄 <b>Керування даними:</b>
• /reset — Повністю очистити базу даних (з підтвердженням).

💡 <b>ШІ-Радник:</b>
• Пиши текстові повідомлення-запити. ШІ дасть пораду, але не може самостійно змінювати статистику!
`;

bot.command(['help', 'commands'], async (ctx) => {
    await ctx.replyWithHTML(helpMessage);
});

// Встановлення початкового залишку
bot.command('setbalance', async (ctx) => {
    const amount = parseFloat(ctx.message.text.split(' ')[1]);
    if (isNaN(amount)) return ctx.reply('Будь ласка, вкажи суму правильно. Наприклад: /setbalance 450.60');
    
    await prisma.transaction.deleteMany({ where: { type: 'init_balance' } });
    await prisma.transaction.create({ data: { type: 'init_balance', amount: amount, category: 'Початковий залишок', description: 'Задано вручну', workspace: 'Особисте' } });
    await ctx.reply(`✅ Початковий залишок на картці успішно зафіксовано: ${amount} грн.`);
});

// Встановлення початкових збережень (Банка)
bot.command('setsavings', async (ctx) => {
    const amount = parseFloat(ctx.message.text.split(' ')[1]);
    if (isNaN(amount)) return ctx.reply('Формат: /setsavings 710');
    
    await prisma.transaction.deleteMany({ where: { type: 'init_saving' } });
    await prisma.transaction.create({ data: { type: 'init_saving', amount: amount, category: 'Початкова банка', description: 'Задано вручну', workspace: 'Особисте' } });
    await ctx.reply(`🏦 Початкові збереження на Банці зафіксовано: ${amount} грн.`);
});

// Ручне відкладання грошей
bot.command('save', async (ctx) => {
    const amount = parseFloat(ctx.message.text.split(' ')[1]);
    if (isNaN(amount)) return ctx.reply('Формат: /save 100');
    
    await prisma.transaction.create({ data: { type: 'saving', amount: amount, category: 'Скарбничка', description: 'Відкладено вручну', workspace: 'Особисте' } });
    await ctx.reply(`🪙 Відкладено ${amount} грн у збереження. Реальний залишок на картці зменшено.`);
});

// Скидання бази
bot.command('reset', async (ctx) => {
    await ctx.reply('⚠️ Ти дійсно хочеш повністю очистити всі транзакції та борги?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Так, очистити все', 'confirm_reset'), Markup.button.callback('❌ Скасувати', 'cancel_reset')]
    ]));
});
bot.action('confirm_reset', async (ctx) => {
    await prisma.transaction.deleteMany({});
    await ctx.editMessageText('🗑 База даних повністю очищена!');
});
bot.action('cancel_reset', async (ctx) => {
    await ctx.editMessageText('Очищення скасовано.');
});

// Борговий модуль
bot.command('debt', async (ctx) => {
    const parts = ctx.message.text.replace('/debt', '').trim().split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /debt <сума> <хто дав>');
    await prisma.transaction.create({ data: { type: 'i_owe', amount, category: 'Пасив', description: `Взято у борг від ${name}`, workspace: 'Особисте' } });
    await ctx.reply(`🤝 Зафіксовано пасив: ти винен ${amount} грн (${name}).`);
});

bot.command('lend', async (ctx) => {
    const parts = ctx.message.text.replace('/lend', '').trim().split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /lend <сума> <кому дав>');
    await prisma.transaction.create({ data: { type: 'owe_me', amount, category: 'Актив', description: `Дано у борг ${name}`, workspace: 'Особисте' } });
    await ctx.reply(`🤝 Зафіксовано актив (витрата з залишку): тобі винні ${amount} грн (${name}).`);
});

bot.command('paydebt', async (ctx) => {
    const amount = parseFloat(ctx.message.text.replace('/paydebt', '').trim());
    if (isNaN(amount)) return ctx.reply('Формат: /paydebt <сума>');
    await prisma.transaction.create({ data: { type: 'pay_debt', amount, category: 'Погашення', description: `Віддав частину боргу`, workspace: 'Особисте' } });
    await ctx.reply(`💸 Записано: ти погасив ${amount} грн свого боргу. Залишок зменшено.`);
});

bot.command('getdebt', async (ctx) => {
    const amount = parseFloat(ctx.message.text.replace('/getdebt', '').trim());
    if (isNaN(amount)) return ctx.reply('Формат: /getdebt <сума>');
    await prisma.transaction.create({ data: { type: 'get_debt', amount, category: 'Повернення', description: `Мені повернули борг`, workspace: 'Особисте' } });
    await ctx.reply(`📥 Записано: тобі повернули ${amount} грн боргу. Залишок збільшено.`);
});

bot.command('stats', showStats);

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
            const prompt = `Користувач уточнив транзакцію: "${userText}". 
            Визнач нову type ("income", "expense", "saving", "pay_debt", "get_debt", "i_owe", "owe_me"), category та workspace ("Проєкт" або "Особисте").
            Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;
            const result = await model.generateContent(prompt);
            const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());
            await prisma.transaction.update({ where: { id: txId }, data: { type: aiData.type, category: aiData.category, workspace: aiData.workspace, description: userText } });
            return ctx.reply('✅ Транзакцію та її тип успішно оновлено!');
        } catch (e) {
            return ctx.reply('Не вдалося оновити транзакцію.');
        }
    }

    const waitMsg = await ctx.reply('⏳ Аналізую ваші фінанси...');
    try {
        const stats = await getStatsData();
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

        const advisorPrompt = `
Ти — фінансовий ментор. 
УВАГА: Ти є лише мовною моделлю. Ти НЕ маєш доступу до бази даних і НЕ можеш самостійно додавати транзакції чи змінювати статистику. 
Якщо користувач просить тебе додати гроші, збереження чи борги, ти мусиш пояснити йому, що він має зробити це сам за допомогою відповідних команд бота (наприклад, /save, /setsavings, /debt, /lend).

Поточний стан користувача:
- Реальний залишок (Картка): ${stats.personalBalance} грн.
- Всього в збереженнях (Банка): ${stats.totalSaving} грн.
- ЗАГАЛЬНИЙ КАПІТАЛ: ${stats.totalCapital} грн.
- Активні борги користувача (він винен): ${stats.currentIOwe} грн.
- Йому винні: ${stats.currentOweMe} грн.

Запит користувача: "${userText}"
Завдання: Дай стратегічну пораду. Враховуй борги! Не використовуй markdown зі зірочками, тільки <b>, <i>.
`;

        const adviceResult = await model.generateContent(advisorPrompt);
        let safeResponse = adviceResult.response.text()
            .replace(/<h[1-6]>/g, '<b>')
            .replace(/<\/h[1-6]>/g, '</b>\n')
            .replace(/\*/g, '');

        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.replyWithHTML(`🎩 <b>ТВІЙ РАДНИК:</b>\n\n${safeResponse}`);
    } catch (err) {
        console.error('Помилка AI Радника:', err);
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.reply('Вибач, сталася помилка при аналізі фінансів ШІ.');
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
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        const prompt = `Проаналізуй транзакцію з Монобанку. Сума: ${amount}, Опис: "${description}", Зарахування: ${isIncome}.
        Визнач type: "saving" (поповнення банки), "income", "expense", "get_debt" (повернення боргу ТОБІ), "pay_debt" (погашення ТВОГО боргу).
        Визнач category та workspace ("Проєкт" або "Особисте").
        Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;

        const result = await model.generateContent(prompt);
        const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

        const savedTx = await prisma.transaction.create({
            data: { type: aiData.type, amount: amount, category: aiData.category, description: description, workspace: aiData.workspace }
        });

        const msg = `🏦 <b>Monobank</b> | Автоматично\n\n📦 <b>Простір:</b> ${aiData.workspace}\n🏷 <b>Категорія:</b> ${aiData.category}\n\n💵 <b>Сума:</b> ${amount} грн\n📝 <b>Опис:</b> ${description}`;
        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Уточнити', `edit_${savedTx.id}`)]]) });
    } catch (e) {
        console.error('Помилка обробки Монобанку:', e);
    }
});

// --- СТАРТ СЕРВЕРА ТА РЕЄСТРАЦІЯ ВЕБХУКУ ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Сервер працює на порту ${PORT}`);
    
    try {
        await bot.telegram.setMyCommands([
            { command: 'stats', description: '📊 Фінансова статистика' },
            { command: 'setbalance', description: '💵 Встановити початкову картку' },
            { command: 'setsavings', description: '🏦 Встановити початкову банку' },
            { command: 'save', description: '🪙 Відкласти гроші в банку' },
            { command: 'debt', description: '🤝 Взяв у борг (Пасив)' },
            { command: 'lend', description: '🤝 Дав у борг (Актив)' },
            { command: 'paydebt', description: '💸 Віддав свій борг' },
            { command: 'getdebt', description: '📥 Мені повернули борг' },
            { command: 'help', description: 'ℹ️ Список усіх команд' }
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