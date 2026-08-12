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

// Глобальна змінна для збереження стартового балансу в пам'яті/базі
let initialBalance = 0;

// --- ТЕЛЕГРАМ ВЕБХУК НАЛАШТУВАННЯ ---
const WEBHOOK_PATH = `/telegram/${process.env.BOT_TOKEN}`;
app.post(WEBHOOK_PATH, (req, res) => {
    bot.handleUpdate(req.body, res);
});

// --- СТАТИСТИКА ТА РОЗРАХУНКИ ---
const getStatsData = async () => {
    const allTransactions = await prisma.transaction.findMany();
    
    let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0;
    let iOwe = 0, oweMe = 0; // Борги

    allTransactions.forEach(t => {
        if (t.workspace === 'Проєкт') {
            if (t.type === 'income') wIncome += t.amount;
            if (t.type === 'expense') wExpense += t.amount;
        } else {
            if (t.type === 'income') pIncome += t.amount;
            if (t.type === 'expense') pExpense += t.amount;
            if (t.type === 'saving') pSaving += t.amount;
            if (t.type === 'i_owe') iOwe += t.amount;
            if (t.type === 'owe_me') oweMe += t.amount;
        }
    });

    const workProfit = wIncome - wExpense;
    // Формула: Стартовий баланс + Доходи - Витрати - Збереження - Я віддав у борг + Мені повернули
    const personalBalance = initialBalance + pIncome - pExpense - pSaving - oweMe + iOwe;

    return {
        pIncome, pExpense, pSaving, wIncome, wExpense,
        iOwe, oweMe, workProfit, personalBalance
    };
};

const showStats = async (ctx) => {
    try {
        const stats = await getStatsData();
        const message = `📊 <b>ФІНАНСОВА СТАТИСТИКА</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💵 <b>Стартовий капітал:</b> ${initialBalance} грн\n` +
                        `👤 <b>ОСОБИСТИЙ БЮДЖЕТ</b>\n` +
                        `🟢 <b>Доходи:</b> ${stats.pIncome} грн\n` +
                        `🔴 <b>Витрати:</b> ${stats.pExpense} грн\n` +
                        `🟡 <b>Збереження:</b> ${stats.pSaving} грн\n` +
                        `🤝 <b>Мені винні:</b> ${stats.oweMe} грн\n` +
                        `⚠️ <b>Я винен:</b> ${stats.iOwe} грн\n` +
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

bot.start((ctx) => ctx.reply('Привіт! Бот активний і ready for action. Введи /stats для статистики або /help.'));

// 1. Встановлення стартового балансу
bot.command('setbalance', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const amount = parseFloat(args[1]);
    if (isNaN(amount)) {
        return ctx.reply('Будь ласка, вкажи суму правильно. Наприклад: /setbalance 15000');
    }
    initialBalance = amount;
    await ctx.reply(`✅ Стартовий капітал успішно встановлено: ${initialBalance} грн.`);
});

// 2. Скидання бази даних (Reset DB)
bot.command('reset', async (ctx) => {
    await ctx.reply('⚠️ Ти дійсно хочеш повнісю очистити всі транзакції?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Так, очистити все', 'confirm_reset'), Markup.button.callback('❌ Скасувати', 'cancel_reset')]
    ]));
});

bot.action('confirm_reset', async (ctx) => {
    await prisma.transaction.deleteMany({});
    initialBalance = 0;
    await ctx.editMessageText('🗑 База даних повністю очищена! Стартовий баланс скинуто до 0. Вкажи новий баланс через /setbalance.');
});

bot.action('cancel_reset', async (ctx) => {
    await ctx.editMessageText('Очищення скасовано.');
});

// 3. Борговий модуль
bot.command('debt', async (ctx) => {
    // Взяв у борг: /debt 500 Петро
    const text = ctx.message.text.replace('/debt', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';

    if (isNaN(amount)) return ctx.reply('Формат: /debt <сума> <хто дав>. Наприклад: /debt 500 Петро');

    await prisma.transaction.create({
        data: { type: 'i_owe', amount, category: 'Борг', description: `У борг від ${name}`, workspace: 'Особисте' }
    });
    await ctx.reply(`🤝 Записано: ти винен ${amount} грн (${name}).`);
});

bot.command('lend', async (ctx) => {
    // Дав у борг: /lend 200 Олег
    const text = ctx.message.text.replace('/lend', '').trim();
    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    const name = parts.slice(1).join(' ') || 'Хтось';

    if (isNaN(amount)) return ctx.reply('Формат: /lend <сума> <кому дав>. Наприклад: /lend 200 Олег');

    await prisma.transaction.create({
        data: { type: 'owe_me', amount, category: 'Борг', description: `Дав у борг ${name}`, workspace: 'Особисте' }
    });
    await ctx.reply(`🤝 Записано: тобі винні ${amount} грн (${name}).`);
});

bot.command('stats', showStats);

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // Обробка режиму уточнення
    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Користувач уточнив категорію/опис транзакції: "${userText}". 
            Визнач нову category та workspace ("Проєкт" або "Особисте").
            Формат JSON: {"category": "...", "workspace": "..."}`;
            
            const result = await model.generateContent(prompt);
            const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

            await prisma.transaction.update({
                where: { id: txId },
                data: { category: aiData.category, workspace: aiData.workspace, description: userText }
            });

            return ctx.reply('✅ Транзакцію успішно оновлено!');
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
- Стартовий капітал: ${initialBalance} грн.
- Вільні особисті кошти: ${stats.personalBalance} грн.
- Збереження: ${stats.pSaving} грн.
- Борги користувача (він винен): ${stats.iOwe} грн.
- Йому винні: ${stats.oweMe} грн.

Запит користувача: "${userText}"
Завдання: Дай коротку стратегічну пораду. Враховуй борги! Якщо користувач хоче купити щось дороге, але має активні борги (${stats.iOwe} грн), обов'язково підсвіти це як ризик.
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
    await ctx.reply('Введіть новий опис або деталі для цієї транзакції:');
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
        - Поповнення банки/депозиту/між власними рахунками ("з Чорної картки" на банку) -> "saving"
        - Прибуток/ЗП -> "income"
        - Покупка/Витрата -> "expense"
        
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

        const icon = aiData.type === 'income' ? '🟢' : aiData.type === 'saving' ? '🟡' : '🔴';
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
    
    // Реєструємо Webhook для Telegram при кожному запуску
    if (process.env.RENDER_EXTERNAL_URL) {
        const fullWebhookUrl = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(fullWebhookUrl);
        console.log(`Telegram Webhook встановлено: ${fullWebhookUrl}`);
    }
});