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

// --- MIDDLEWARE: ЖОРСТКИЙ WHITELIST ТА АЛЕРТ ---
bot.use(async (ctx, next) => {
   // ✅ НОВИЙ КОД (ПРОПУСКАЄ І ТЕКСТ, І КНОПКИ):
    if (!ctx.message && !ctx.callbackQuery) {
        return;
    }

    const allowedUserId = Number(process.env.MY_CHAT_ID);
    const userId = ctx.from?.id;

    // 2. Якщо це я пропускаємо - далі
    if (userId === allowedUserId) {
        return next();
    }

    // 3. Збираємо дані про unavtorized user для мого сповіщення
    const firstName = ctx.from?.first_name || 'Без імені';
    const lastName = ctx.from?.last_name || '';
    const username = ctx.from?.username ? `@${ctx.from.username}` : 'немає юзернейму';
    const isPremium = ctx.from?.is_premium ? '⭐ Telegram Premium' : 'Звичайний акаунт';
    const lang = ctx.from?.language_code || 'невідомо';
    const textSent = ctx.message?.text || '[медіа/команда]';

    const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv'});

    // FULL досьє для мене
    const alertMsg = 
`🚨 <b>!IMPORTANT! Несанкціонований вхід — відхилено</b>

👤 <b>Користувач:</b> ${firstName} ${lastName} (${username})
🆔 <b>ID:</b> <code>${userId}</code>
💎 <b>Статус:</b> ${isPremium}
🌐 <b>Мова додатка:</b> ${lang}
💬 <b>Спроба відправити:</b> <i>"${textSent}"</i>
📅 <b>Час:</b> ${now}

🔗 <a href="tg://user?id=${userId}">Переглянути профіль користувача</a>`;

    try {
        await bot.telegram.sendMessage(allowedUserId, alertMsg, { parse_mode: 'HTML'});
    } catch (e) {
        console.error('Помилка відправки алерту про Unavtorized User', e);
    }

    // 3. Екран відмови для Unavtorized User
    const rejectMsg = 
`🛑 <b>TERMINAL ACCESS RESTRICTED</b>
━━━━━━━━━━━━━━━━━━━
⚠️ <b>PROTOCOL: DISCOVERY_DENIED (403)</b>

Система зафіксувала спробу несанкціонованого проникнення до приватного фінансового ядра. 

⚙️ <b>СИСТЕМНИЙ ЛОГ:</b>
• <b>Target ID:</b> <code>${userId}</code>
• <b>Threat Level:</b> <code>CRITICAL</code>
• <b>Action:</b> IP & Session Isolated

🛡 <i>Ваші ідентифікатори передані адміністратору. Термінал заблоковано. Подальші спроби будуть розцінені як пряма атака.</i>`;

    return ctx.replyWithHTML(rejectMsg);
}) 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userStates = {};

// 🛡 Хелпер для безпечного екранування спецсимволів HTML
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 📊 Хелпер для генерації візуального прогрес-бару
function generateProgressBar(current, total, length = 10) {
    if (total <= 0) return '<code>[▰▰▰▰▰▰▰▰▰▰]</code> <b>100%</b>';

    //Розраховуємо відсоток (не більше 100% і не меньше 0%)
    const percentage = Math.min(Math.max((current / total) * 100, 0), 100);
    const filledLength = Math.round((length * percentage) / 100);
    const emptyLength = length - filledLength;
    
    //Задаємо що зелені квадрати - закритий борг, червоні залишок боргу
    const filledBar = '▰'.repeat(filledLength);
    const emptyBar = '▱'.repeat(emptyLength);

    return `<code>[${filledBar}${emptyBar}]</code> <b>${percentage.toFixed(0)}%</b>`;
}


// 🧹 Хелпер для очистки відповідей Gemini від Markdown-артефактів
function cleanAiResponse(text) {
    if (!text) return '';
    return text
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')  // Замінюємо **жирний** на <b>
        .replace(/\*(.*?)\*/g, '<i>$1</i>')      // Замінюємо *курсив* на <i>
        .replace(/`/g, '');                      // Прибираємо бeктіки
}

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
        currentIOwe, currentOweMe, workProfit, personalBalance, totalCapital,
        iOweTotal,payDebtTotal
    };
};

const showStats = async (ctx) => {
    try {
        const stats = await getStatsData();

        const totalDebt = stats.payDebtTotal + stats.currentIOwe;
        const debtProgressBar = generateProgressBar(stats.payDebtTotal, totalDebt);
        const hasDebt = stats.currentIOwe > 0 || stats.payDebtTotal > 0;

        const message = 
`📊 <b>ФІНАНСОВА СТАТИСТИКА</b>
━━━━━━━━━━━━━━━━━━━━━
🏁 <b>Початковий залишок:</b> <code>${stats.initBalance.toFixed(2)}</code> грн

👱 <b>ОСОБИСТИЙ БЮДЖЕТ</b>
🟢 <b>Доходи:</b> <code>${stats.pIncome.toFixed(2)}</code> грн
🔴 <b>Витрати:</b> <code>${stats.pExpense.toFixed(2)}</code> грн
🟡 <b>Збереження (Банка/Кеш):</b> <code>${stats.pSaving.toFixed(2)}</code> грн
💳 <b>РЕАЛЬНИЙ ЗАЛИШОК (Картка):</b> <code>${stats.personalBalance.toFixed(2)}</code> грн
🤝 <b>Мені винні (Актив):</b> <code>${stats.currentOweMe.toFixed(2)}</code> грн
⚠️ <b>Я винен (Пасив):</b> <code>${stats.currentIOwe.toFixed(2)}</code> грн
${hasDebt ? `📉 <b>Виплата боргу:</b> ${debtProgressBar}` : ''}
━━━━━━━━━━━━━━━━━━━━━
💰 <b>ЗАГАЛЬНИЙ КАПІТАЛ:</b> <code>${stats.totalCapital.toFixed(2)}</code> грн
━━━━━━━━━━━━━━━━━━━━━
💼 <b>ПРОЄКТИ ТА ФРИЛАНС</b>
🟢 <b>Доходи:</b> <code>${stats.wIncome.toFixed(2)}</code> грн
🔴 <b>Витрати:</b> <code>${stats.wExpense.toFixed(2)}</code> грн
📈 <b>Чиста рентабельність:</b> <code>${stats.workProfit.toFixed(2)}</code> грн`;
        
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

// БЕЗПЕЧНЕ СКИДАННЯ БАЗИ (2FA Reset) ---
bot.command('reset', async (ctx) => {
    const userId = ctx.from.id;
    delete userStates[userId];

    await ctx.reply('⚠️ <b>УВАГА!</b> Ви дійсно хочете повністю очистити всі дані фінансового обліку та історію?', {
       parse_mode: 'HTML',
       ...Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Так, продовжити', 'start_reset_confirm'),
            Markup.button.callback('❌ Ні, скасувати', 'cancel_reset')
        ]
       ]) 
    });
});

bot.action('start_reset_confirm', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    //Включаємо стан очікування кодового слова
    userStates[userId] = { awaitingResetConfirm: true};

    await ctx.editMessageText(
       '🚨 <b>ОСТАННЄ ПІДТВЕРДЖЕННЯ!</b>\n\nДля остаточного видалення всіх транзакцій та історії напишіть у чат фразу:\n<code>ОЧИСТИТИ ДАНІ</code>',
        { parse_mode: 'HTML' } 
    );
});

bot.action('cancel_reset', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    if (userStates[userId]) delete userStates[userId].awaitingResetConfirm;

    await ctx.editMessageText('🛑 <b>Операцію з очищення даних скасовано.</b> Усі фінанси в безпеці.', { parse_mode: 'HTML' });
});

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

// --- РУЧНЕ ДОДАВАННЯ ТРАНЗАКЦІЇ /add ---
bot.command('add', async (ctx) => {
    const userId = ctx.from.id;
    delete userStates[userId]; // Скасовуємо редагування про всяк випадок

    const text = ctx.message.text.replace('/add', '').trim();
    if (!text) {
        return ctx.replyWithHTML('⚠️ <b>Формат:</b> <code>/add &lt;сума&gt; &lt;опис&gt;</code>\nНаприклад: <code>/add 40 Вода в Рідному Краї</code>');
    }

    const parts = text.split(' ');
    const amount = parseFloat(parts[0]);
    if (isNaN(amount)) {
        return ctx.replyWithHTML('⚠️ Вкажи суму першим числом.\nНаприклад: <code>/add 40 Вода в Рідному Краї</code>');
    }

    const description = parts.slice(1).join(' ') || 'Ручна витрата';
    const statusMsg = await ctx.reply('⏳ Записую витрату...');

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        const prompt = `Проаналізуй фінансову витрату користувача: "${description}", сума: ${amount}.

Визнач type ("expense", "income", "saving"), category (коротко 1-2 слова) та workspace ("Особисте" або "Проєкт").
Формат JSON: {"type": "expense", "category": "...", "workspace": "..."}`;

        //Rerty механізм для Google API
        let result;
        try {
            result = await model.generateContent(prompt);
        } catch (retryErr) {
            await new Promise(res => setTimeout (res, 1000));
            result = await model.generateContent(prompt);
        }

        const textResponse = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(textResponse);

        await prisma.transaction.create({
            data: {
                type: aiData.type || 'expense',
                amount: amount,
                category: aiData.category || 'Загальне',
                description: description,
                workspace: aiData.workspace || 'Особисте'
            }
        });

        return await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            `✅ <b>Витрату успішно додано!</b>\n\n💵 <b>Сума:</b> <code>${amount.toFixed(2)}</code> грн\n🏷 <b>Категорія:</b> ${aiData.category}\n📦 <b>Простір:</b> ${aiData.workspace}\n📝 <b>Опис:</b> <i>${escapeHtml(description)}</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {
        console.error('Помилка /add', e);
        // Фоллбек: якщо Gemini повністю впав, зберігаємо просто як "Загальне"
        await prisma.transaction.create({
            data: {type: 'expense', amount: amount, category: 'Загальне', description: description, workspace: 'Особисте' }
        });
        return await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            `✅ <b>Витрату додано!</b> (Категорія: Загальне, AI недоступний)\n💵 <b>Сума:</b> <code>${amount.toFixed(2)}</code> грн`,
            { parse_mode: 'HTML' }
        );
    }

});

// --- ФУНКЦІЇ ПАМ'ЯТІ ЧАТУ ---

// 1. Збереження повідомлення в базу
async function saveChatMessage(userId, role, text) {
    try {
        await prisma.chatHistory.create({
            data: {
                userId: BigInt(userId),
                role: role, // 'user' або 'model'
                text: text
            }
        });
    } catch (e) {
        console.error('Помилка збереження історії:', e);
    }    
}

// 2. Зчитування останніх 10 повідомлень у форматі Gemini SDK
async function getChatHistory(userId) {
    try {
        const history = await prisma.chatHistory.findMany({
            where: { userId: BigInt(userId) },
            orderBy: { createdAt: 'desc' },
            take: 10
        });

        // 1. Спочатку форматуємо масив
        const formattedHistory = history.reverse().map(item => ({
            role: item.role,
            parts: [{ text: item.text }]
        }));

        // 2. Логуємо для діагностики в термінал
        console.log('📜 Завантажена історія з Supabase:', JSON.stringify(formattedHistory, null, 2));

        // 3. І тільки в кінці повертаємо результат
        return formattedHistory;

    } catch (e) {
        console.error('Помилка зчитування історії:', e);
        return [];
    }
}

// --- ОБРОБКА КНОПКИ "ОЧИСТИТИ ІСТОРІЮ" ---
bot.hears('🧹 Очистити історію', async (ctx) => {
    const reminder = 
`💡 <b>Щоб візуально очистити екран чату:</b>

1. Натисни на <b>3 крапки</b> у правому верхньому кутку (або на аватар бота).
2. Обери <b>«Очистити історію»</b> (Clear History).

<i>Усі ваші дані, статистика та база Supabase залишаться в безпеці!</i>`;
    await ctx.replyWithHTML(reminder);
})

// --- ОБРОБКА КНОПКИ "УТОЧНИТИ" ---
bot.action(/^edit_(\d+)$/, async (ctx) => {
    //1. Зупиняємо анімацію завантаження на кнопці в Telegram
    await ctx.answerCbQuery();

    const txId = parseInt(ctx.match[1], 10);
    const userId = ctx.from.id;

    //2. Зберігаємо стан редагування для користувача
    userStates[userId] = {
        isEditing: true,
        txId: txId
    };

    await ctx.reply('✍️ Вкажи уточнення для цієї транзакції (наприклад: <i>"Одяг, купив куртку"</i>):', { parse_mode: 'HTML' });
});

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI З ПАМ'ЯТЮ ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    //ЗАХИСТ: Якщо це команда, скасовуємо будь-яке редагування і виходимо
    if (userText.startsWith('/')) {
        delete userStates[userId];
        return;
    }

    if (userStates[userId] && userStates[userId].awaitingResetConfirm) {
        if (userText.trim() === 'ОЧИСТИТИ ДАНІ') {
            delete userStates[userId];
            const statusMsg = await ctx.reply('⏳ Очищаю базу даних та історію...');

            try {
                await prisma.transaction.deleteMany({});
                await prisma.chatHistory.deleteMany({});

                return await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    statusMsg.message_id,
                    null,
                    '🗑 <b>Базу даних та історію успішно очищено в 0!</b>\nВстанови новий початковий залишок через /setbalance.',
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                console.error('Помилка очищення: ', e);
                return await ctx.reply('❌ Помилка при очищенні бази.');
            }
        } else {
            delete userStates[userId].awaitingResetConfirm;
            return await ctx.reply('🛑 <b>Текст введено невірно!</b> Операцію з очищення даних скасовано.', { parse_mode: 'HTML' });
        }
    }

    console.log(`📩 Нове повідомлення від ${userId}: "${userText}"`);

    // 1. Режим "Уточнити"
    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];

        // ⚡ UX-Фікс: Миттєва відповідь користувачу, щоб прибрати візуальну затримку
        const statusMsg = await ctx.reply('⏳ Аналізую новий опис та оновлюю категорію...');


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
            
            // 🔄 Автоматичний повтор запиту (Retry) якщо Google видав 503      
            let result;
            try {
                result = await model.generateContent(prompt);
            } catch (retryErr) {
                console.warn('⚠️ Тимчасове перевантаження Gemini (503), робимо повторний запит...');
                await new Promise(res => setTimeout(res, 1000)); // пауза 1 секунда
                result = await model.generateContent(prompt);
            }

            const textResponse = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
            const aiData = JSON.parse(textResponse);
            
            await prisma.transaction.update({
                where: { id: txId },
                data: { 
                    type: aiData.type, 
                    category: aiData.category, 
                    workspace: aiData.workspace, 
                    description: userText 
                }
            });

            // 🎯 Редагуємо статусне повідомлення на успіх
            return await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `✅ <b>Транзакцію успішно оновлено!</b>\n🏷 <b>Категорія:</b> ${aiData.category}\n📦 <b>Простір:</b> ${aiData.workspace}`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Помилка оновлення уточнення:', e);
            return await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                '❌ Не вдалося оновити транзакцію (сервери AI тимчасово перевантажені).'
            );
        }
    }

    // 2. AI Радник з інтегрованою пам'яттю (Chat History) та контекстом фінансів
    const waitMsg = await ctx.reply('⏳ Аналізую ваші фінанси...');
    try {
        const stats = await getStatsData();
        
        // Зчитуємо історію з перевіркою на масив
        let rawHistory = await getChatHistory(userId);
        let history = Array.isArray(rawHistory) ? rawHistory : [];

        // --- ФІКС: Gemini вимагає, щоб масив починався ТІЛЬКИ з 'user' ---
        while (history.length > 0 && history[0].role !== 'user') {
            history.shift(); // Видаляємо найстаріше повідомлення, якщо це 'model'
        }

        console.log(`📜 Завантажено елементів історії для Gemini: ${history.length}`);

        const systemInstruction = `
Ти — фінансовий ментор та аналітик.
Поточний стан користувача:
- Вільні кошти (Картка): ${stats.personalBalance} грн.
- Загальний капітал: ${stats.totalCapital} грн.
- Збереження (Кеш/Банки): ${stats.pSaving} грн.
- Активні борги користувача (він винен): ${stats.currentIOwe} грн.
- Йому винні: ${stats.currentOweMe} грн.

Правила відповідей:
1. Відповідай коротко, лаконічно, дружньо та по суті.
2. Враховуй попередній контекст діалогу.
3. Використовуй тільки базовий HTML (<b>, <i>). НЕ використовуй Markdown зі зірочками!
4. Якщо користувач хоче зробити витрату, але має борги чи малий баланс — підсвіти це як ризик.
`;

        // Ініціалізація чату
       // 1. Ініціалізуємо модель з іншою назвою змінної (advisorModel)
        const advisorModel = genAI.getGenerativeModel({ 
            model: "gemini-3.5-flash",
            systemInstruction: systemInstruction 
        });

        // 2. Ініціалізація чату
        const chat = advisorModel.startChat({
            history: history
        });

        let adviceResult;
        try {
            adviceResult = await chat.sendMessage(userText);
        } catch (retryErr) {
            console.warn('⚠️ Тимчасове перевантаження Gemini (503) у Раднику, пауза 1 сек...');
            await new Promise(res => setTimeout(res, 1000));
            adviceResult = await chat.sendMessage(userText);
        }

        let safeResponse = cleanAiResponse(adviceResult.response.text())
            .replace(/<h[1-6]>/g, '<b>')
            .replace(/<\/h[1-6]>/g, '</b>\n')
            .replace(/\*/g, '');

        // 3. Відправляємо відповідь користувачу
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.replyWithHTML(`🎩 <b>ТВІЙ РАДНИК:</b>\n\n${safeResponse}`);

        // 4. Зберігаємо обидва повідомлення в Supabase
        await saveChatMessage(userId, 'user', userText);
        await saveChatMessage(userId, 'model', safeResponse);

        console.log('💾 Запит та відповідь успішно записані в Supabase!');
    } catch (err) {
        console.error('❌ Помилка в блоці AI Радника:', err);
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.reply('Вибач, сталася помилка при аналізі фінансів ШІ.');
    }
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

        // 🛡 Екрануємо зовнішній текст від спецсимволів
        const cleanDescription = escapeHtml(description);
        const cleanCategory = escapeHtml(aiData.category);


       const msg = `🏦 <b>Monobank</b> | Автоматично\n\n` +
                    `📦 <b>Простір:</b> ${aiData.workspace}\n` +
                    `🏷 <b>Категорія:</b> ${cleanCategory}\n\n` +
                    `💵 <b>Сума:</b> <code>${amount.toFixed(2)}</code> грн\n` +
                    `📝 <b>Опис:</b> <i>${cleanDescription}</i>`;

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

// --- Генерація 5-компонентного AI-аналізу (Gemini) ---
async function generateDailyAiAnalysis(dailyData) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash"});

        //1. Отримуємо транзакції за останні 7 днів для порівняння з середнім чеком
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const pastWeekTx = await prisma.transaction.findMany({
            where: {
                createdAt: { gte: sevenDaysAgo},
                type: 'expense'
            }
        });

        const totalWeekExpense = pastWeekTx.reduce((sum, t) => sum + t.amount, 0);
        const avgDailyExpense = totalWeekExpense / 7;

        //2. Формуємо промпт
        const prompt = `
        Ти — особистий фінансовий аналітик та тренер. 
        Проаналізуй фінансовий день користувача та надай коротку, влучну, структуровану аналітику (до 4-5 речень).

        ДАНІ ЗА СЬОГОДНІ:
        - Доходи за день: ${dailyData.dayIncome} грн
        - Витрати за день: ${dailyData.dayExpense} грн
        - Категорії витрат за сьогодні: ${JSON.stringify(dailyData.categoryExpenses)}
        - Реальний залишок на картці: ${dailyData.realBalance} грн
        - Загальний капітал: ${dailyData.totalCapital} грн

        КОНТЕКСТ ДЛЯ ПОРІВНЯННЯ:
        - Середні денні витрати за останні 7 днів: ${avgDailyExpense.toFixed(2)} грн

        СФОРМУЙ ВІДПОВІДЬ ЗА ТАКИМИ 5 ПУНКТАМИ (використовуй емодзі, будь дружнім, але практичним):
        1. **Порівняння:** Порівняй сьогоднішні витрати із середніми за тиждень (${avgDailyExpense.toFixed(2)} грн).
        2. **Структура:** Оціни, на що пішли гроші (чи були це імпульсивні витрати, чи необхідні). Якщо витрат 0 — похвали за "сухий день".
        3. **Заощадження/Капітал:** Коротка порада щодо збережень або балансу.
        4. **Питання на вечір:** Постав ОДНЕ влучне запитання про сьогоднішні рішення/покупки, яке змусить замислитися.

        Пиши українською мовою, без складних термінів, стисло та по суті.
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error('Помилка генерації AI аналізу:', error);
        return "Не вдалося згенерувати AI-аналіз за сьогодні.";
    }

}
    
// --- АВТОМАТИЧНИЙ ЩОДЕННИЙ ЗВІТ (Cron Job) ---
cron.schedule('59 23 * * *', async () => {
    console.log('⏰ Запуск вечірнього звіту...');
    try {
        const data = await getDailyReportData();

        //Форматуємо поточну дату (наприклад: "21 серпня 2026")
        const todayFormatted = new Date().toLocaleDateString('uk-UA', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        let categoriesText = '';
        for (const [cat, sum] of Object.entries(data.categoryExpenses)) {
            categoriesText += `  • ${escapeHtml(cat)}: <code>${sum.toFixed(2)}</code> грн\n`;
        }

        const rawAiAnalysis = await generateDailyAiAnalysis(data);
        const aiAnalysis = cleanAiResponse(rawAiAnalysis);

        const reportMessage = 
`🌙 <b>ФІНАНСОВИЙ ПІДСУМОК ДНЯ — ${todayFormatted}</b>
━━━━━━━━━━━━━━━━━━
🟢 <b>Доходи за день:</b> +<code>${data.dayIncome.toFixed(2)}</code> грн
🔴 <b>Витрати за день:</b> -<code>${data.dayExpense.toFixed(2)}</code> грн

${categoriesText ? `📂 <b>Категорії витрат:</b>\n${categoriesText}` : '👌 Сьогодні витрат не було!\n'}
💳 <b>Реальний залишок (Картка):</b> <code>${data.realBalance.toFixed(2)}</code> грн
💰 <b>Загальний капітал:</b> <code>${data.totalCapital.toFixed(2)}</code> грн
━━━━━━━━━━━━━━━━━━
🤖 <b>AI-Аналітик:</b>
${aiAnalysis}`;

        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, reportMessage, { parse_mode: 'HTML' });

        // Зберігаємо вечірній аналіз в історію чату, щоб Gemini пам'ятала своє запитання
        await saveChatMessage(process.env.MY_CHAT_ID, 'model', reportMessage);
    } catch (error) {
        console.error('Помилка відправки авто-звіту:', error);
    }
}, {
    timezone: "Europe/Kyiv"
});

app.listen(PORT, async () => {
    console.log(`Сервер працює на порту ${PORT}`);
    
    // ПОВЕРНУТО: Реєстрація меню підказок в самому Telegram
    // Реєстрація меню команд ТІЛЬКИ для тебе (конкретного chat_id)
    try {
        const allowedUserId = Number(process.env.MY_CHAT_ID);

        // 1. Очищаємо дефолтне меню для всіх чужинців
        await bot.telegram.setMyCommands([]);

        // 2. Встановлюємо список команд ТІЛЬКИ для твого ID
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
            { command: 'reset', description: '⚠️ Очистити всі дані' },
            { command: 'add', description: '➕ Ручна витрата (сума категорія опис)' }
        ], {
            scope: { type: 'chat', chat_id: allowedUserId }
        });

        console.log('✅ Персональне меню команд встановлено!');
    } catch (err) {
        console.error('Помилка встановлення меню команд:', err);
    }

    if (process.env.RENDER_EXTERNAL_URL) {
        const fullWebhookUrl = `${process.env.RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(fullWebhookUrl);
        console.log(`Telegram Webhook встановлено: ${fullWebhookUrl}`);
    }
});