require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
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
    let initSaving = 0; // Додана змінна
    let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0; 
    let oweMeTotal = 0, getDebtTotal = 0; 

    allTransactions.forEach(t => {
        if (t.type === 'init_balance') {
            initBalance += t.amount;
        } else if (t.type === 'init_saving') {
            initSaving += t.amount; // Тут іде стартова сума
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') wIncome += t.amount;
            if (t.type === 'expense') wExpense += t.amount;
        } else {
            if (t.type === 'income') pIncome += t.amount;
            if (t.type === 'expense') pExpense += t.amount;
            if (t.type === 'saving') pSaving += t.amount; // Виправлено назад на pSaving
            if (t.type === 'i_owe') iOweTotal += t.amount;
            if (t.type === 'pay_debt') payDebtTotal += t.amount;
            if (t.type === 'owe_me') oweMeTotal += t.amount;
            if (t.type === 'get_debt') getDebtTotal += t.amount;
        }
    });

    const workProfit = wIncome - wExpense;
    const currentIOwe = iOweTotal - payDebtTotal;
    const currentOweMe = oweMeTotal - getDebtTotal;

    // Від картки віднімаються ТІЛЬКИ фізичні перекази на банку (pSaving)
    const personalBalance = initBalance + (pIncome + wIncome) - (pExpense + wExpense) - oweMeTotal + getDebtTotal - payDebtTotal;
    
    // Збираємо всі збереження разом (стартові + поповнення)
    const totalSavings = initSaving + pSaving; 
    
    // Загальний капітал (Картка + Банка)
    const totalCapital = personalBalance + totalSavings; 

    return {
        initBalance, pIncome, pExpense, pSaving: totalSavings, wIncome, wExpense,
        currentIOwe, currentOweMe, workProfit, personalBalance, totalCapital
    };
};

const showStats = async (ctx) => {
    try {
        const stats = await getStatsData();
        const message = `📊 <b>ФІНАНСОВА СТАТИСТИКА</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `🏁 <b>Початковий залишок:</b> ${stats.initBalance.toFixed(2)} грн\n` +
                        `👤 <b>ОСОБИСТИЙ БЮДЖЕТ</b>\n` +
                        `🟢 <b>Доходи:</b> ${stats.pIncome.toFixed(2)} грн\n` +
                        `🔴 <b>Витрати:</b> ${stats.pExpense.toFixed(2)} грн\n` +
                        `🟡 <b>Збереження (Банка/Кеш):</b> ${stats.pSaving.toFixed(2)} грн\n` +
                        `🤝 <b>Мені винні (Актив):</b> ${stats.currentOweMe.toFixed(2)} грн\n` +
                        `⚠️ <b>Я винен (Пасив):</b> ${stats.currentIOwe.toFixed(2)} грн\n` +
                        `💳 <b>РЕАЛЬНИЙ ЗАЛИШОК (Картка):</b> ${stats.personalBalance.toFixed(2)} грн\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💰 <b>ЗАГАЛЬНИЙ КАПІТАЛ:</b> ${stats.totalCapital.toFixed(2)} грн\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💼 <b>ПРОЄКТИ ТА ФРИЛАНС</b>\n` +
                        `🟢 <b>Доходи:</b> ${stats.wIncome.toFixed(2)} грн\n` +
                        `🔴 <b>Витрати:</b> ${stats.wExpense.toFixed(2)} грн\n` +
                        `📈 <b>Чиста рентабельність:</b> ${stats.workProfit.toFixed(2)} грн`;
        
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
• /sync <code>&lt;сума&gt;</code> — <b>Синхронізувати баланс</b>. Вирівнює баланс бота з реальною карткою.
• /setsavings <code>&lt;сума&gt;</code> — Синхронізувати суму збережень (Банка/Готівка).

🤝 <b>Модуль Боргів (Debt Tracker):</b>
• /debt <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти взяв у борг (Пасив).
• /lend <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти дав у борг (Актив).
• /paydebt <code>&lt;сума&gt;</code> — Погасити частину/весь свій борг.
• /getdebt <code>&lt;сума&gt;</code> — Зафіксувати, що тобі повернули борг.

🔄 <b>Керування даними:</b>
• /reset — Повністю очистити базу даних (з підтвердженням).

💡 <b>ШІ-Радник:</b>
• Пиши будь-яке повідомлення і ШІ дасть пораду на базі твого бюджету.
`;

bot.command(['help', 'commands'], async (ctx) => {
    await ctx.replyWithHTML(helpMessage);
});

bot.command('setbalance', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const amount = parseFloat(args[1]);
    if (isNaN(amount)) return ctx.reply('Будь ласка, вкажи суму. Наприклад: /setbalance 450.60');
    
    await prisma.transaction.deleteMany({ where: { type: 'init_balance' } });
    await prisma.transaction.create({
        data: { type: 'init_balance', amount: amount, category: 'Початковий залишок', description: 'Задано вручну', workspace: 'Особисте' }
    });
    await ctx.reply(`✅ Початковий залишок успішно зафіксовано: ${amount} грн.`);
});

bot.command('sync', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const realAmount = parseFloat(args[1]);
    if (isNaN(realAmount)) return ctx.reply('⚠️ Формат: /sync <сума на картці>. Наприклад: /sync 99.60');

    const allTransactions = await prisma.transaction.findMany();
    let initBalanceId = null;
    let pIncome = 0, pExpense = 0, wIncome = 0, wExpense = 0;
    let payDebtTotal = 0, oweMeTotal = 0, getDebtTotal = 0;

    allTransactions.forEach(t => {
        if (t.type === 'init_balance') {
            initBalanceId = t.id;
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') wIncome += t.amount;
            if (t.type === 'expense') wExpense += t.amount;
        } else {
            if (t.type === 'income') pIncome += t.amount;
            if (t.type === 'expense') pExpense += t.amount;
            if (t.type === 'pay_debt') payDebtTotal += t.amount;
            if (t.type === 'owe_me') oweMeTotal += t.amount;
            if (t.type === 'get_debt') getDebtTotal += t.amount;
        }
    });

    const newInitBalance = realAmount - (pIncome + wIncome) + (pExpense + wExpense) + oweMeTotal - getDebtTotal + payDebtTotal;

    if (initBalanceId) {
        await prisma.transaction.update({ where: { id: initBalanceId }, data: { amount: newInitBalance } });
    } else {
        await prisma.transaction.create({ data: { type: 'init_balance', amount: newInitBalance, category: 'Синхронізація', workspace: 'Особисте' } });
    }
    await ctx.reply(`✅ Синхронізовано! Математику вирівняно під ${realAmount} грн.\nСтатистика витрат та доходів повністю збережена.`);
});

bot.command('setsavings', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const targetAmount = parseFloat(args[1]);
    if (isNaN(targetAmount)) return ctx.reply('⚠️ Формат: /setsavings <сума>. Наприклад: /setsavings 5000');

    const allTransactions = await prisma.transaction.findMany({ where: { OR: [{ type: 'saving' }, { type: 'init_saving' }] } });
    let currentDynamicSavings = 0;
    let initSavingId = null;

    allTransactions.forEach(t => {
        if (t.type === 'init_saving') initSavingId = t.id;
        else if (t.type === 'saving') currentDynamicSavings += t.amount;
    });

    const newInitSaving = targetAmount - currentDynamicSavings;

    if (initSavingId) {
        await prisma.transaction.update({ where: { id: initSavingId }, data: { amount: newInitSaving } });
    } else {
        await prisma.transaction.create({ data: { type: 'init_saving', amount: newInitSaving, category: 'Стартове збереження', workspace: 'Особисте' } });
    }
    await ctx.reply(`✅ Збереження успішно синхронізовано! Тепер у скарбничці: ${targetAmount} грн.`);
});

bot.command('reset', async (ctx) => {
    await ctx.reply('⚠️ Ти дійсно хочеш повністю очистити всі транзакції та борги?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Так, очистити все', 'confirm_reset'), Markup.button.callback('❌ Скасувати', 'cancel_reset')]
    ]));
});

bot.action('confirm_reset', async (ctx) => {
    await prisma.transaction.deleteMany({});
    await ctx.editMessageText('🗑 База даних повністю очищена! Вкажи новий початковий залишок через /setbalance.');
});
bot.action('cancel_reset', async (ctx) => { await ctx.editMessageText('Очищення скасовано.'); });

bot.command('debt', async (ctx) => {
    const text = ctx.message.text.replace('/debt', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /debt <сума> <хто дав>. Наприклад: /debt 500 Петро');
    await prisma.transaction.create({ data: { type: 'i_owe', amount, category: 'Пасив', description: `Взято у борг від ${name}`, workspace: 'Особисте' } });
    await ctx.reply(`🤝 Зафіксовано пасив: ти винен ${amount} грн (${name}).`);
});

bot.command('lend', async (ctx) => {
    const text = ctx.message.text.replace('/lend', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';
    if (isNaN(amount)) return ctx.reply('Формат: /lend <сума> <кому дав>. Наприклад: /lend 200 Олег');
    await prisma.transaction.create({ data: { type: 'owe_me', amount, category: 'Актив', description: `Дано у борг ${name}`, workspace: 'Особисте' } });
    await ctx.reply(`🤝 Зафіксовано актив (витрата з залишку): тобі винні ${amount} грн (${name}).`);
});

bot.command('paydebt', async (ctx) => {
    const amount = parseFloat(ctx.message.text.replace('/paydebt', '').trim());
    if (isNaN(amount)) return ctx.reply('Формат: /paydebt <сума>. Наприклад: /paydebt 5000');
    await prisma.transaction.create({ data: { type: 'pay_debt', amount, category: 'Погашення', description: `Віддав частину боргу`, workspace: 'Особисте' } });
    await ctx.reply(`💸 Записано: ти погасив ${amount} грн свого боргу. Залишок на картці зменшено.`);
});

bot.command('getdebt', async (ctx) => {
    const amount = parseFloat(ctx.message.text.replace('/getdebt', '').trim());
    if (isNaN(amount)) return ctx.reply('Формат: /getdebt <сума>. Наприклад: /getdebt 2000');
    await prisma.transaction.create({ data: { type: 'get_debt', amount, category: 'Повернення', description: `Мені повернули борг`, workspace: 'Особисте' } });
    await ctx.reply(`📥 Записано: тобі повернули ${amount} грн боргу. Залишок на картці збільшено.`);
});

bot.command('stats', showStats);

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Режим "Уточнити"
    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
            const prompt = `Проаналізуй фінансову транзакцію. 
Користувач написав / Опис транзакції: "${userText}".

ТИ ПОВИНЕН ОБРАТИ TYPE ТІЛЬКИ З ЦЬОГО СПИСКУ ЗА СУВОРИМИ ПРАВИЛАМИ:
1. Переміщення активів -> type: "saving" (Зняття готівки, переказ на свою банку, крипта).
2. Справжні витрати -> type: "expense" (Покупки, їжа, підписки).
3. Справжній дохід -> type: "income" (Зарплата, дохід від продажу).
4. Логіка боргів: "i_owe" (взяв борг), "owe_me" (дав борг), "pay_debt" (віддаєш свій борг), "get_debt" (тобі повертають).

ПРАВИЛА ДЛЯ WORKSPACE ("Проєкт" або "Особисте"):
- "Проєкт": Все, що стосується IT, Node.js, Telegram-ботів, poster.baza та фрілансу.
- "Особисте": Спортзал, кіно, побут, переміщення готівки.

Визнач type, category (коротко, 1-2 слова) та workspace. Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;
            
            const result = await model.generateContent(prompt);
            const textResponse = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
            const aiData = JSON.parse(textResponse);

            await prisma.transaction.update({
                where: { id: txId },
                data: { type: aiData.type, category: aiData.category, workspace: aiData.workspace, description: userText }
            });

            return ctx.reply('✅ Транзакцію та її тип успішно оновлено!');
        } catch (e) {
            console.error('Помилка оновлення уточнення:', e);
            return ctx.reply('Не вдалося оновити транзакцію.');
        }
    }

    // AI Радник
    const waitMsg = await ctx.reply('⏳ Аналізую ваші фінанси...');
    try {
        const stats = await getStatsData();
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

        const advisorPrompt = `
Ти — фінансовий ментор.
Поточний стан користувача:
- Початковий залишок: ${stats.initBalance} грн.
- Вільні кошти (Реальний залишок на картці): ${stats.personalBalance} грн.
- Збереження (Кеш/Банки): ${stats.pSaving} грн.
- Загальний капітал: ${stats.totalCapital} грн.
- Активні борги користувача (він винен): ${stats.currentIOwe} грн.
- Йому винні: ${stats.currentOweMe} грн.

Запит користувача: "${userText}"
Завдання: Дай коротку стратегічну пораду. Враховуй борги! Якщо користувач хоче зробити витрату, але має активні борги чи від'ємний баланс, підсвіти це як ризик.
Правило: Використовуй тільки базовий HTML (<b>, <i>). Не використовуй markdown зі зірочками.
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

bot.action(/edit_(\d+)/, async (ctx) => {
    const txId = parseInt(ctx.match[1]);
    userStates[ctx.from.id] = { isEditing: true, txId: txId };
    await ctx.reply('Введіть новий опис (наприклад: "Обмін в готівку", "Оплата за постер", "Погасив борг Сані"):');
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
    const monoId = item.id;

    try {
        // ВИПРАВЛЕНО: Перевірка на дублікати (якщо такий monoId вже є, ігноруємо)
        const existingTx = await prisma.transaction.findFirst({ where: { monoId: monoId } });
        if (existingTx) return;

        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        const prompt = `Проаналізуй фінансову транзакцію. 
Опис: "${description}". Сума: ${amount}. Зарахування: ${isIncome}.

ТИ ПОВИНЕН ОБРАТИ TYPE ТІЛЬКИ З ЦЬОГО СПИСКУ ЗА СУВОРИМИ ПРАВИЛАМИ:
1. Переміщення активів -> type: "saving" (Зняття готівки, переказ на свою банку, крипта).
2. Справжні витрати -> type: "expense" (Покупки, їжа, підписки).
3. Справжній дохід -> type: "income" (Зарплата, дохід від продажу).
4. Логіка боргів: "i_owe" (взяв борг), "owe_me" (дав борг), "pay_debt" (віддаєш свій борг), "get_debt" (тобі повертають).

ПРАВИЛА ДЛЯ WORKSPACE ("Проєкт" або "Особисте"):
- "Проєкт": Все, що стосується IT, Node.js, Telegram-ботів, poster.baza та фрілансу.
- "Особисте": Спортзал, кіно, побут, переміщення готівки.

Визнач type, category (коротко, 1-2 слова) та workspace. Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(textResponse);

        const savedTx = await prisma.transaction.create({
            data: {
                monoId: monoId, // Зберігаємо ID від Монобанку
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
app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});

// --- ФУНКЦІЯ ЗБОРУ ДЕННОЇ СТАТИСТИКИ ---
async function getDailyReportData() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 1. Отримуємо транзакції конкретно за сьогодні
    const dailyTx = await prisma.transaction.findMany({
        where: {
            createdAt: {
                gte: startOfDay,
                lte: endOfDay
            }
        }
    });

    let dayIncome = 0;
    let dayExpense = 0;
    const categoryExpenses = {};

    dailyTx.forEach(t => {
        if (t.type === 'income') {
            dayIncome += t.amount;
        } else if (t.type === 'expense') {
            dayExpense += t.amount;
            categoryExpenses[t.category] = (categoryExpenses[t.category] || 0) + t.amount;
        }
    });

    // 2. Викликаємо існуючу функцію getStatsData() для загальних залишків
    const globalStats = await getStatsData();

    return {
        dayIncome,
        dayExpense,
        categoryExpenses,
        realBalance: globalStats.personalBalance,
        totalCapital: globalStats.totalCapital
    };
}

// --- АВТОМАТИЧНИЙ ЩОДЕННИЙ ЗВІТ (Cron Job) ---
cron.schedule('59 23 * * *', async () => {
    console.log('⏰ Запуск вечірнього звіту...');
    try {
        const data = await getDailyReportData();

        let categoriesText = '';
        for (const [cat, sum] of Object.entries(data.categoryExpenses)) {
            categoriesText += `  • ${cat}: ${sum.toFixed(2)} грн\n`;
        }

        const reportMessage = 
`🌙 **ФІНАНСОВИЙ ПІДСУМОК ДНЯ**
──────────────────
🟢 **Доходи за день:** +${data.dayIncome.toFixed(2)} грн
🔴 **Витрати за день:** -${data.dayExpense.toFixed(2)} грн

${categoriesText ? `📂 **Категорії витрат:**\n${categoriesText}` : '👌 Сьогодні витрат не було!\n'}
💳 **Реальний залишок (Картка):** ${data.realBalance.toFixed(2)} грн
💰 **Загальний капітал:** ${data.totalCapital.toFixed(2)} грн
──────────────────`;

        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, reportMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Помилка відправки авто-звіту:', error);
    }
}, {
    timezone: "Europe/Kyiv"
});

app.listen(PORT, async () => {
    console.log(`Сервер працює на порту ${PORT}`);
    
    // ПОВЕРНУТО: Реєстрація меню підказок в самому Telegram
    try {
        await bot.telegram.setMyCommands([
            { command: 'stats', description: '📊 Фінансова статистика' },
            { command: 'sync', description: '🔄 Синхронізувати баланс з карткою' },
            { command: 'setsavings', description: '🟡 Встановити суму збережень' },
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