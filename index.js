require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateTextWithFallback, generateTextWithRetry } = require('./fallback-ai');
const { getMonthlyAnalyticsData } = require('./monthly-analytics');
const { generateMonthlyAudit } = require('./monthly-ai');

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
    const allTransactions = await prisma.transaction.findMany({ 
        where: { is_deleted: false }
    });
    
    let initBalance = 0;
    let initSaving = 0;
    let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0; 
    let oweMeTotal = 0, getDebtTotal = 0; 

    let cardBalance = 0;
    let cashBalance = 0;

    allTransactions.forEach(t => {
        const source = t.source || 'card';

        if (t.type === 'init_balance') {
            initBalance += t.amount;
            cardBalance += t.amount;
        } else if (t.type === 'init_saving') {
            initSaving += t.amount;
        } else if (t.type === 'transfer') {
            if (source === 'card' && t.toSource === 'cash') {
                cardBalance -= t.amount;
                cashBalance += t.amount;
            } else if (source === 'cash' && t.toSource === 'card') {
                cashBalance -= t.amount;
                cardBalance += t.amount;
            }
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') {
                wIncome += t.amount;
                if (source === 'cash') cashBalance += t.amount; else cardBalance += t.amount;
            }
            if (t.type === 'expense') {
                wExpense += t.amount;
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            }
        } else {
            if (t.type === 'income') {
                pIncome += t.amount;
                if (source === 'cash') cashBalance += t.amount; else cardBalance += t.amount;
            }
            if (t.type === 'expense') {
                pExpense += t.amount;
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            }
            if (t.type === 'saving') {
                pSaving += t.amount;
                //ФІКС: Збереження в Банку зменшують картку (або кеш)!
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            } 
            if (t.type === 'i_owe') iOweTotal += t.amount;
            if (t.type === 'pay_debt') {
                payDebtTotal += t.amount;
                cardBalance -= t.amount; // Виплата боргу зменшує картку
            }
            if (t.type === 'owe_me') {
                oweMeTotal += t.amount;
                cardBalance -= t.amount; // Дав у борг — зменшує картку
            }
            if (t.type === 'get_debt') {
                getDebtTotal += t.amount;
                cardBalance += t.amount; // Повернули борг — збільшує картку
            }
        }
    });

    const workProfit = wIncome - wExpense;
    const currentIOwe = iOweTotal - payDebtTotal;
    const currentOweMe = oweMeTotal - getDebtTotal;

    const totalSavings = initSaving + pSaving; 
    // Загальний капітал = реальна картка + реальна готівка + банки/збереження
    const totalCapital = cardBalance + cashBalance + totalSavings; 

    return {
        initBalance, pIncome, pExpense, pSaving: totalSavings, wIncome, wExpense,
        currentIOwe, currentOweMe, workProfit, personalBalance: cardBalance, totalCapital,
        iOweTotal, payDebtTotal, cardBalance, cashBalance
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
💳 <b>РЕАЛЬНИЙ ЗАЛИШОК (Картка):</b> <code>${stats.cardBalance.toFixed(2)}</code> грн
💵 <b>ГОТІВКА (Кеш):</b> <code>${stats.cashBalance.toFixed(2)}</code> грн
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
• /monthly — 🔥 <b>Фінансовий аудит за місяць</b> (Прожарка від AI у стилі Кнопка Аліна + ТОП-10 категорій + план дій).
• /setbalance <code>&lt;сума&gt;</code> — Встановити початковий залишок (точка відліку на картці).
• /sync <code>&lt;сума&gt;</code> — <b>Синхронізувати баланс</b>. Вирівнює баланс бота з реальною карткою.
• /setsavings <code>&lt;сума&gt;</code> — Синхронізувати суму збережень (Банка/Готівка).

🤝 <b>Модуль Боргів (Debt Tracker):</b>
• /debt <code>&lt;сума&gt; &lt;ім'я&gt;</code> — Зафіксувати, що ти взяв у борг (Пасив).
• /lend <code>&lt;сума&gt; &lt;кому дав&gt;</code> — Зафіксувати, що ти дав у борг (Актив).
• /paydebt <code>&lt;сума&gt;</code> — Погасити частину/весь свій борг.
• /getdebt <code>&lt;сума&gt;</code> — Зафіксувати, що тобі повернули борг.

🔄 <b>Керування даними:</b>
• /reset — Повністю очистити базу даних (з підтвердженням).
• /undo — <b>Скасувати останню дію</b> (Ctrl+Z для випадкових витрат).

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

// --- ХЕЛПЕР СМАРТ-СИНХРОНІЗАЦІЇ (РЕКОНСИЛЯЦІЯ БАЛАНСУ) ---
async function processBalanceSync(realAmount) {
    const stats = await getStatsData();
    const diff = realAmount - stats.cardBalance;

    // Якщо різниця 0 — баланси вже ідеально збігаються
    if (Math.abs(diff) < 0.01) {
        return {
            synced: false,
            message: `👌 <b>Баланс уже ідеальний!</b>\nНа картці в боті та по факту рівно <code>${realAmount.toFixed(2)}</code> грн.`
        };
    }

    const isExpenseCorrection = diff < 0;
    const absDiff = Math.abs(diff);

    // Створюємо компенсуючу транзакцію замість зміни init_balance
    await prisma.transaction.create({
        data: {
            type: isExpenseCorrection ? 'expense' : 'income',
            amount: absDiff,
            source: 'card',
            category: '🛠 Коригування',
            description: isExpenseCorrection 
                ? `Смарт-синхронізація (невраховані витрати: -${absDiff.toFixed(2)} грн)`
                : `Смарт-синхронізація (неврахований дохід: +${absDiff.toFixed(2)} грн)`,
            workspace: 'Особисте'
        }
    });

    const statusIcon = isExpenseCorrection ? '🔴' : '🟢';
    const msg = `🔄 <b>СМАРТ-СИНХРОНІЗАЦІЯ ВИКОНАНА</b>\n━━━━━━━━━━━━━━━━━━━\n` +
                `💳 <b>Було в боті:</b> <code>${stats.cardBalance.toFixed(2)}</code> грн\n` +
                `🎯 <b>Встановлено факт:</b> <code>${realAmount.toFixed(2)}</code> грн\n` +
                `${statusIcon} <b>Коригування:</b> <code>${isExpenseCorrection ? '-' : '+'}${absDiff.toFixed(2)}</code> грн (категорія: 🛠 Коригування)\n\n` +
                `<i>Початковий залишок збережено без змін. Математика історії повністю чиста.</i>`;

    return { synced: true, message: msg };
}


// --- КОМАНДА /sync ---
bot.command('sync', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const realAmount = parseFloat(args[1]);
    if (isNaN(realAmount)) return ctx.reply('⚠️ Формат: /sync <сума на картці>. Наприклад: /sync 358.36');

    const result = await processBalanceSync(realAmount);
    await ctx.replyWithHTML(result.message);
});

bot.command('setsavings', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const targetAmount = parseFloat(args[1]);
    if (isNaN(targetAmount)) return ctx.reply('⚠️ Формат: /setsavings <сума>. Наприклад: /setsavings 5000');

   const allTransactions = await prisma.transaction.findMany({ 
        where: { 
            is_deleted: false,
            OR: [{ type: 'saving' }, { type: 'init_saving' }] 
        } 
    });
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

// --- КОМАНДА /undo (Smart Batch Soft Delete) ---
bot.command('undo', async (ctx) => {
    try {
        // 1. Знаходимо останню АКТИВНУ транзакцію
        const lastTx = await prisma.transaction.findFirst({
            where: { is_deleted: false },
            orderBy: { createdAt: 'desc' }
        });

        if (!lastTx) {
            return ctx.reply('❌ Немає активних транзакцій для скасування.');
        }

        // 2. Якщо є batchId — скасовуємо весь пакет, інакше тільки її одну
        if (lastTx.batchId) {
            const batchTxs = await prisma.transaction.findMany({
                where: { batchId: lastTx.batchId, is_deleted: false }
            });

            await prisma.transaction.updateMany({
                where: { batchId: lastTx.batchId },
                data: { is_deleted: true }
            });

            const totalAmount = batchTxs.reduce((sum, t) => sum + t.amount, 0);

            return await ctx.replyWithHTML(
                `🔄 <b>ПАКЕТНУ ОПЕРАЦІЮ УСПІШНО СКАСОВАНО!</b>\n━━━━━━━━━━━━━━━━━━━\n` +
                `❌ <b>Скасовано операцій у ланцюжку:</b> ${batchTxs.length}\n` +
                `💵 <b>Загальна сума пакету:</b> <code>${totalAmount.toFixed(2)}</code> грн\n\n` +
                `<i>Увесь ланцюжок дій деактивовано, баланс перераховано!</i>`
            );
        } else {
            // Одинарне скасування
            await prisma.transaction.update({
                where: { id: Number(lastTx.id) },
                data: { is_deleted: true }
            });

            const typeLabel = lastTx.type === 'income' ? '🟢 Дохід' 
                            : lastTx.type === 'expense' ? '🔴 Витрату' 
                            : lastTx.type === 'transfer' ? '🔁 Переказ' 
                            : '🟡 Операцію';

            return await ctx.replyWithHTML(
                `🔄 <b>ОПЕРАЦІЮ УСПІШНО СКАСОВАНО!</b>\n━━━━━━━━━━━━━━━━━━━\n` +
                `❌ <b>Позначено як видалену:</b> ${typeLabel}\n` +
                `💵 <b>Сума:</b> <code>${lastTx.amount.toFixed(2)}</code> грн\n` +
                `🏷 <b>Категорія:</b> ${escapeHtml(lastTx.category)}\n` +
                `📝 <b>Опис:</b> <i>${escapeHtml(lastTx.description)}</i>\n\n` +
                `<i>Статистика та баланс автоматично вирівняні!</i>`
            );
        }
    } catch (e) {
        console.error('💥 КРИТИЧНА ПОМИЛКА В /undo:', e);
        await ctx.reply('❌ Сталася помилка при спробі скасувати останню транзакцію.');
    }
});

// --- РУЧНЕ ДОДАВАННЯ ТРАНЗАКЦІЇ /add ---
bot.command('add', async (ctx) => {
    const userId = ctx.from.id;
    delete userStates[userId];

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
        const prompt = `Проаналізуй фінансову витрату користувача: "${description}", сума: ${amount}.

Визнач type ("expense", "income", "saving"), category (коротко 1-2 слова) та workspace ("Особисте" або "Проєкт").
Формат JSON: {"type": "expense", "category": "...", "workspace": "..."}`;

        const { text: textResponse, provider } = await generateTextWithFallback(prompt);
        console.log(`🤖 /add оброблено через: ${provider}`);

        const cleanJson = textResponse.trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(cleanJson);

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
            `✅ <b>Витрату успішно додано!</b>\n\n💵 <b>Сума:</b> <code>${amount.toFixed(2)}</code> грн\n🏷 <b>Категорія:</b> ${escapeHtml(aiData.category)}\n📦 <b>Простір:</b> ${aiData.workspace}\n📝 <b>Опис:</b> <i>${escapeHtml(description)}</i>\n\n🤖 <i>Оброблено через: ${provider}</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {
        console.error('Помилка /add', e);
        await prisma.transaction.create({
            data: { type: 'expense', amount: amount, category: 'Загальне', description: description, workspace: 'Особисте' }
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

// --- КОМАНДА /monthly (AI Фінансовий Аудит) ---
bot.command('monthly', async (ctx) => {
    // Стильний та емоційний екран очікування
    const loadingMsg = await ctx.replyWithHTML(
        `💼 <b>ВИКЛИКАЮ ФІНАНСОВОГО АУДИТОРА...</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `📊 Збираю дані про ваші статки, доходи та борги...\n` +
        `🔍 Шукаю "пожирачів" бюджету серед ТОП-10 категорій...\n` +
        `🧠 Готую жорсткий аналіз та "прожарку"...\n\n` +
        `<i>Зачекайте 10-15 секунд, аудитор вивчає ваші чеки ⏳</i>`
    );

    try {
        // 1. Збір аналітики з БД
        const analytics = await getMonthlyAnalyticsData();

        // Перевірка на порожній місяць
        if (analytics.metrics.income === 0 && analytics.metrics.expense === 0) {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
            return await ctx.reply('📊 У цьому місяці ще немає жодної зафіксованої транзакції. Почни вести бюджет, а потім приходь за аудитом!');
        }

        // 2. Генерація AI-аудиту
        const aiResult = await generateMonthlyAudit(analytics);

        // 3. Формування тексту "Сухих цифр"
        const m = analytics.metrics;
        const deltaIcon = m.delta >= 0 ? '🟢' : '🔴';
        
        let top3Text = '';
        analytics.topCategories.slice(0, 3).forEach((c, i) => {
            top3Text += `   ${i + 1}. <b>${escapeHtml(c.category)}</b>: <code>${c.amount.toFixed(2)}</code> грн\n`;
        });

        let responseMessage = '';

        if (aiResult.success) {
            const audit = aiResult.audit;
            const rating = Number(audit.rating) || 5;

            // Динамічний заголовок за "Рейтингом П*здєца"
            let headerBadge = '⚠️ <b>Є ПИТАННЯ ДО БЮДЖЕТУ</b>';
            if (rating <= 3) headerBadge = '🚨 <b>ФІНАНСОВА КАТАСТРОФА</b>';
            if (rating >= 8) headerBadge = '👑 <b>ВОВК З УОЛЛ-СТРІТ</b>';

            let actionPlanText = '';
            if (Array.isArray(audit.action_plan)) {
                audit.action_plan.forEach(step => {
                    actionPlanText += `🔹 ${escapeHtml(step)}\n`;
                });
            }

            responseMessage = 
                `${headerBadge} (Оцінка: <b>${rating}/10</b>)\n` +
                `━━━━━━━━━━━━━━━━━━━\n\n` +
                `📊 <b>ЦИФРИ МІСЯЦЯ:</b>\n` +
                `🟢 Доходи: <code>${m.income.toFixed(2)}</code> грн\n` +
                `🔴 Витрати: <code>${m.expense.toFixed(2)}</code> грн\n` +
                `${deltaIcon} Дельта: <code>${m.delta.toFixed(2)}</code> грн\n` +
                `💰 Загальний капітал: <code>${m.totalCapital.toFixed(2)}</code> грн\n` +
                `🏦 Заощаджено: <code>${m.savings.toFixed(2)}</code> грн\n` +
                `⚠️ Мій борг: <code>${m.myDebt.toFixed(2)}</code> грн\n\n` +
                `🏆 <b>ТОП-3 ПОЖИРАЧІ:</b>\n${top3Text}\n` +
                `🗣 <b>ВЕРДИКТ АУДИТОРА:</b>\n<i>"${escapeHtml(audit.verdict)}"</i>\n\n` +
                `🧨 <b>ПРОЖАРКА:</b>\n${escapeHtml(audit.roast_section)}\n\n` +
                `🤝 <b>ЩО ХОРОШОГО:</b>\n${escapeHtml(audit.praise_section)}\n\n` +
                `📝 <b>ПЛАН ДІЙ НА НАСТУПНИЙ МІСЯЦЬ:</b>\n${actionPlanText}\n` +
                `🤖 <i>Аудит згенеровано через: ${aiResult.provider}</i>`;
        } else {
            responseMessage = 
                `📊 <b>ЗВІТ ЗА МІСЯЦЬ (СУХІ ЦИФРИ)</b>\n` +
                `━━━━━━━━━━━━━━━━━━━\n\n` +
                `🟢 Доходи: <code>${m.income.toFixed(2)}</code> грн\n` +
                `🔴 Витрати: <code>${m.expense.toFixed(2)}</code> грн\n` +
                `${deltaIcon} Дельта: <code>${m.delta.toFixed(2)}</code> грн\n` +
                `💰 Загальний капітал: <code>${m.totalCapital.toFixed(2)}</code> грн\n` +
                `⚠️ Борг: <code>${m.myDebt.toFixed(2)}</code> грн\n\n` +
                `🏆 <b>ТОП-3 ПОЖИРАЧІ:</b>\n${top3Text}\n` +
                `⚠️ <i>AI-Аудитор тимчасово недоступний, але цифри пораховано точно.</i>`;
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        return await ctx.replyWithHTML(responseMessage);

    } catch (e) {
        console.error('💥 Помилка виконання /monthly:', e);
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        return await ctx.reply('❌ Сталася помилка під час формування місячного аудиту.');
    }
});

// --- ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ТА РАДНИКА AI З ПАМ'ЯТЮ ---
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const userText = ctx.message.text;

    // ЗАХИСТ: Якщо це команда, скасовуємо будь-яке редагування і виходимо
    if (userText.startsWith('/')) {
        delete userStates[userId];
        return;
    }

    // 1. СТАН: Підтвердження скидання даних (2FA Reset)
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

    // 2. СТАН: Режим "Уточнити"
    if (userStates[userId] && userStates[userId].isEditing) {
        const txId = userStates[userId].txId;
        delete userStates[userId];

        const statusMsg = await ctx.reply('⏳ Аналізую новий опис та оновлюю категорію...');

        try {
            const prompt = `Проаналізуй фінансову транзакцію. 
Користувач написав / Опис транзакції: "${userText}".

ТИ ПОВИНЕН ОБРАТИ TYPE ТІЛЬКИ З ЦЬОГО СПИСКУ ЗА СУВОРИМИ ПРАВИЛАМИ:
1. Переміщення активів -> type: "saving" або "transfer".
2. Справжні витрати -> type: "expense".
3. Справжній дохід -> type: "income".
4. Логіка боргів: "i_owe", "owe_me", "pay_debt", "get_debt".

ПРАВИЛА ДЛЯ WORKSPACE ("Проєкт" або "Особисте"):
- "Проєкт": ТІЛЬКИ власні стартапи, пет-проєкти, фріланс, poster.baza, замовлення та Telegram-боти.
- "Особисте": Основна офіційна робота (включно з IT/підтримкою), зарплата, ЗП, спортзал, кіно, побут, переміщення готівки.

Визнач type, category (коротко, 1-2 слова) та workspace. Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;

            const { text: textResponse, provider } = await generateTextWithFallback(prompt);
            console.log(`🤖 Уточнення оброблено через: ${provider}`);
            const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const aiData = JSON.parse(cleanJson);
            
            await prisma.transaction.update({
                where: { id: txId },
                data: { 
                    type: aiData.type, 
                    category: aiData.category, 
                    workspace: aiData.workspace, 
                    description: userText 
                }
            });

            return await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `✅ <b>Транзакцію успішно оновлено!</b>\n🏷 <b>Категорія:</b> ${escapeHtml(aiData.category)}\n📦 <b>Простір:</b> ${aiData.workspace}`,
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

    console.log(`📩 Нове повідомлення від ${userId}: "${userText}"`);

    // 3. AI-РОУТЕР: Автоматична перевірка на транзакцію у звичайному тексті
    const intentData = await classifyUserIntent(userText);

   // 3.1. Обробка безшовного наміру SYNC
    if (intentData && intentData.intent === 'SYNC' && typeof intentData.amount === 'number') {
        const syncResult = await processBalanceSync(intentData.amount);
        return await ctx.replyWithHTML(syncResult.message);
    }

    // 3.2. Обробка TRANSACTION (одинарні та пакетні Multi-Transaction)
    if (intentData && intentData.isTransaction && Array.isArray(intentData.transactions) && intentData.transactions.length > 0) {
        const batchId = intentData.transactions.length > 1 ? crypto.randomUUID() : null;
        const createdTxList = [];

        for (const tx of intentData.transactions) {
            const savedTx = await prisma.transaction.create({
                data: {
                    type: tx.type || 'expense',
                    amount: Number(tx.amount),
                    source: tx.source || 'card',
                    toSource: tx.toSource || null,
                    category: tx.category || 'Загальне',
                    description: tx.description || userText,
                    workspace: tx.workspace || 'Особисте',
                    batchId: batchId
                }
            });
            createdTxList.push(savedTx);
        }

        if (createdTxList.length === 1) {
            // Одинарна транзакція
            const tx = createdTxList[0];
            const icon = tx.type === 'income' ? '🟢' : tx.type === 'transfer' ? '🔁' : '🔴';
            const sourceInfo = tx.type === 'transfer' 
                ? ` (${tx.source === 'card' ? '💳' : '💵'} ➔ ${tx.toSource === 'cash' ? '💵' : '💳'})`
                : ` (${tx.source === 'cash' ? '💵 Готівка' : '💳 Картка'})`;

            return await ctx.replyWithHTML(
                `✅ <b>Транзакцію зафіксовано!</b>\n\n` +
                `${icon} <b>Сума:</b> <code>${tx.amount.toFixed(2)}</code> грн${sourceInfo}\n` +
                `🏷 <b>Категорія:</b> ${escapeHtml(tx.category)}\n` +
                `📦 <b>Простір:</b> ${tx.workspace}\n` +
                `📝 <b>Опис:</b> <i>${escapeHtml(tx.description)}</i>`,
                Markup.inlineKeyboard([[Markup.button.callback('✏️ Уточнити', `edit_${tx.id}`)]])
            );
        } else {
            // Пакетна транзакція (Multi-Transaction)
            let msg = `📦 <b>ПАКЕТНО ОБРОБЛЕНО (${createdTxList.length} ОПЕРАЦІЙ)</b>\n━━━━━━━━━━━━━━━━━━━\n`;
            createdTxList.forEach((tx, idx) => {
                const icon = tx.type === 'income' ? '🟢' : tx.type === 'transfer' ? '🔁' : '🔴';
                msg += `${idx + 1}. ${icon} <b>${tx.amount.toFixed(2)} грн</b> — ${escapeHtml(tx.category)} (<i>${escapeHtml(tx.description)}</i>)\n`;
            });
            msg += `\n<i>Усі операції пов'язані в один пакет. Команда /undo скасує весь ланцюжок.</i>`;

            return await ctx.replyWithHTML(msg);
        }
    }

    // 4. AI-РАДНИК: Обробка запитань, розмов та фінансових аналізів
    const waitMsg = await ctx.reply('⏳ Аналізую ваші фінанси...');
    try {
        const stats = await getStatsData();
        
        let rawHistory = await getChatHistory(userId);
        let history = Array.isArray(rawHistory) ? rawHistory : [];

        // Перевірка: масив має починатися з 'user' для Gemini SDK
        while (history.length > 0 && history[0].role !== 'user') {
            history.shift();
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
3. Якщо користувач хоче зробити витрату, але має борги чи малий баланс — підсвіти це як ризик.
`;

        const advisorModel = genAI.getGenerativeModel({ 
            model: "gemini-3.5-flash",
            systemInstruction: systemInstruction 
        });

        const chat = advisorModel.startChat({
            history: history
        });

        let adviceResult;
        try {
            adviceResult = await chat.sendMessage(userText);
        } catch (err) {
            console.warn('⚠️ Первинний запит Gemini не вдався, робимо повтор...', err.message);
            await new Promise(res => setTimeout(res, 1000));
            adviceResult = await chat.sendMessage(userText);
        }

        let safeResponse = cleanAiResponse(adviceResult.response.text())
            .replace(/<h[1-6]>/g, '<b>')
            .replace(/<\/h[1-6]>/g, '</b>\n')
            .replace(/\*/g, '');

        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.replyWithHTML(`🎩 <b>ТВІЙ РАДНИК:</b>\n\n${safeResponse}`);

        await saveChatMessage(userId, 'user', userText);
        await saveChatMessage(userId, 'model', safeResponse);

        console.log('💾 Запит та відповідь успішно записані в Supabase!');
    } catch (err) {
        console.error('❌ Помилка в блоці AI Радника:', err);
        await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
        await ctx.reply('Вибач, сталася помилка при аналізі фінансів ШІ.');
    }
});

// --- ВЕБХУК МОНОБАНКУ (З ЖОРСТКИМ ФІЛЬТРОМ ПАРНИХ БАНК) ---
app.post('/monobank', async (req, res) => {
    res.status(200).send('OK'); 
    
    const data = req.body?.data;
    if (!data || !data.statementItem) return;

    const item = data.statementItem;
    const amount = Math.abs(item.amount) / 100;
    const commission = item.commissionRate ? Math.abs(item.commissionRate) / 100 : 0;
    const description = item.description || 'Транзакція Monobank';
    const isIncome = item.amount > 0;
    const monoId = item.id;

    if (monoId && monoId.startsWith('test_')) {
        console.log('🧪 Тестовий вебхук успішно прийнято!');
        return;
    }

    try {
        const existingTx = await prisma.transaction.findFirst({ where: { monoId: monoId } });
        if (existingTx) return;

        // 🛑 ЗАЛІЗОБЕТОННИЙ ФІЛЬТР: Ігноруємо парне зарахування (+) на Банку/депозит
        const lowerDesc = description.toLowerCase();
        const isJarDeposit = isIncome && (
            lowerDesc.includes('депозит') || 
            lowerDesc.includes('банка') || 
            lowerDesc.includes('накопичен') ||
            item.mcc === 4829 || item.mcc === 6012
        );

        if (isJarDeposit) {
            console.log(`ℹ️ Ігноруємо парне зарахування на Банку/депозит: "${description}"`);
            return;
        }

        // ДЕТЕКТОР ЗНЯТТЯ ГОТІВКИ (Спліт без AI)
        const isCashWithdrawal = lowerDesc.includes('зняття готівки') || 
                                 lowerDesc.includes('банкомат') || 
                                 item.mcc === 6011;

        if (isCashWithdrawal) {
            const cleanAmount = amount - commission; 

            const savedTx = await prisma.transaction.create({
                data: {
                    monoId: monoId,
                    type: 'transfer',
                    amount: cleanAmount,
                    source: 'card',
                    toSource: 'cash',
                    category: 'Зняття готівки',
                    description: description,
                    workspace: 'Особисте'
                }
            });

            if (commission > 0) {
                await prisma.transaction.create({
                    data: {
                        monoId: `${monoId}_commission`,
                        type: 'expense',
                        amount: commission,
                        source: 'card',
                        category: 'Комісії банку',
                        description: `Комісія: ${description}`,
                        workspace: 'Особисте'
                    }
                });
            }

            const cleanDescription = escapeHtml(description);
            const msg = `🏦 <b>Monobank</b> | Автоматично\n\n` +
                        `🏧 <b>Операція:</b> Зняття готівки (Спліт)\n` +
                        `💵 <b>У готівку:</b> <code>${cleanAmount.toFixed(2)}</code> грн (💳 ➔ 💵)\n` +
                        `${commission > 0 ? `💸 <b>Комісія банку:</b> <code>${commission.toFixed(2)}</code> грн\n` : ''}` +
                        `📝 <b>Опис:</b> <i>${cleanDescription}</i>`;

            return await bot.telegram.sendMessage(process.env.MY_CHAT_ID, msg, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Уточнити', `edit_${savedTx.id}`)]])
            });
        }

        // ЗВИЧАЙНІ ТРАНЗАКЦІЇ (Захищений виклик AI)
        let aiData = { type: isIncome ? 'income' : 'expense', category: 'Загальне', workspace: 'Особисте' };

        try {
            const prompt = `Проаналізуй фінансову транзакцію. 
Опис: "${description}". Сума: ${amount}. Зарахування: ${isIncome}.

ТИ ПОВИНЕН ОБРАТИ TYPE ТІЛЬКИ З ЦЬОГО СПИСКУ ЗА СУВОРИМИ ПРАВИЛАМИ:
1. Переміщення активів -> type: "saving" або "transfer" (Якщо опис містить "банка", "депозит", "накопичення" чи "з чорної картки" при поповненні банки — СТАКАТИ "saving").
2. Справжні витрати -> type: "expense" (Покупки, їжа, підписки).
3. Справжній дохід -> type: "income" (Зарплата, дохід від продажу).
4. Логіка боргів: "i_owe", "owe_me", "pay_debt", "get_debt".

ПРАВИЛА ДЛЯ WORKSPACE ("Проєкт" або "Особисте"):
- "Проєкт": ТІЛЬКИ власні стартапи, пет-проєкти, фріланс, poster.baza, замовлення та Telegram-боти.
- "Особисте": Основна офіційна робота (включно з IT/підтримкою), зарплата, ЗП, спортзал, кіно, побут, переміщення готівки.

Визнач type, category (коротко, 1-2 слова) та workspace. Формат JSON: {"type": "...", "category": "...", "workspace": "..."}`;

            const { text: textResponse, provider } = await generateTextWithFallback(prompt);
            console.log(`🤖 Monobank webhook оброблено через: ${provider}`);
            const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            aiData = JSON.parse(cleanJson);
        } catch (aiErr) {
            console.warn('⚠️ ШІ недоступний при обробці Монобанку, ставлю "Загальне":', aiErr.message);
        }

        const savedTx = await prisma.transaction.create({
            data: {
                monoId: monoId, 
                type: aiData.type || (isIncome ? 'income' : 'expense'),
                amount: amount,
                source: 'card',
                category: aiData.category || 'Загальне',
                description: description,
                workspace: aiData.workspace || 'Особисте'
            }
        });

        const cleanDescription = escapeHtml(description);
        const cleanCategory = escapeHtml(aiData.category || 'Загальне');

        const msg = `🏦 <b>Monobank</b> | Автоматично\n\n` +
                    `📦 <b>Простір:</b> ${aiData.workspace || 'Особисте'}\n` +
                    `🏷 <b>Категорія:</b> ${cleanCategory}\n\n` +
                    `💵 <b>Сума:</b> <code>${amount.toFixed(2)}</code> грн\n` +
                    `📝 <b>Опис:</b> <i>${cleanDescription}</i>`;

        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, msg, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Уточнити', `edit_${savedTx.id}`)]])
        });

    } catch (e) {
        console.error('💥 Критична помилка обробки Монобанку:', e);
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
            },
            is_deleted: false
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
    
// --- ДОПОМІЖНА ФУНКЦІЯ ГЕНЕРАЦІЇ АНАЛІЗУ (З ПОВЕРНЕННЯМ ПРОВАЙДЕРА ТА СТАРИМ ПРОМПТОМ) ---
async function generateDailyAiAnalysis(dailyData) {
    // 1. Отримуємо транзакції за останні 7 днів для порівняння з середнім чеком
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const pastWeekTx = await prisma.transaction.findMany({
        where: {
            createdAt: { gte: sevenDaysAgo },
            type: 'expense',
            is_deleted: false
        }
    });

    const totalWeekExpense = pastWeekTx.reduce((sum, t) => sum + t.amount, 0);
    const avgDailyExpense = totalWeekExpense / 7;

    // 2. Деталізований 4-пунктовий промпт
    const prompt = `
Ти — особистий фінансовий аналітик та тренер. 
Проаналізуй фінансовий день користувача та надай коротку, влучну, структуровану аналітику.

ДАНІ ЗА СЬОГОДНІ:
- Доходи за день: ${dailyData.dayIncome} грн
- Витрати за день: ${dailyData.dayExpense} грн
- Категорії витрат за сьогодні: ${JSON.stringify(dailyData.categoryExpenses)}
- Реальний залишок на картці: ${dailyData.realBalance} грн
- Загальний капітал: ${dailyData.totalCapital} грн

КОНТЕКСТ ДЛЯ ПОРІВНЯННЯ:
- Середні денні витрати за останні 7 днів: ${avgDailyExpense.toFixed(2)} грн

СФОРМУЙ ВІДПОВІДЬ СУВОРО ЗА ТАКИМИ 4 ПУНКТАМИ (використовуй емодзі, звертайся на "ви" або "ти" в дружньому тоні):
1. 📉 **Порівняння:** Порівняй сьогоднішні витрати із середніми за тиждень (${avgDailyExpense.toFixed(2)} грн).
2. 🍿 **Структура:** Оціни, на що пішли гроші (чи були це імпульсивні витрати, чи необхідні). Якщо витрат 0 — похвали за "сухий день".
3. 💰 **Капітал:** Коротка порада щодо збережень або балансу на основі поточного капіталу (${dailyData.totalCapital} грн).
4. 🧐 **Питання на вечір:** Постав ОДНЕ влучне запитання про сьогоднішні рішення/покупки, яке змусить замислитися.

Пиши українською мовою, без складних термінів, стисло та по суті.
`;

    // 3. Використовуємо функцію з чергою та повторними спробами (5 спроб по 12 сек)
    const result = await generateTextWithRetry(prompt, 5, 12000);
    return result; // Повертає { text, provider }
}

// --- 1. АВТОМАТИЧНИЙ ЩОДЕННИЙ ЗВІТ (23:54) ---
cron.schedule('54 23 * * *', async () => {
    console.log('⏰ Запуск вечірнього звіту...');
    try {
        const data = await getDailyReportData();

        const todayFormatted = new Date().toLocaleDateString('uk-UA', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        let categoriesText = '';
        if (data.categoryExpenses && Object.keys(data.categoryExpenses).length > 0) {
            for (const [cat, sum] of Object.entries(data.categoryExpenses)) {
                categoriesText += `  • ${escapeHtml(cat)}: <code>${sum.toFixed(2)}</code> грн\n`;
            }
        }

        let aiText = '';
        let aiProvider = '';

        try {
            // 1. Намагаємося згенерувати аналіз через AI з повторними спробами
            const aiRes = await generateDailyAiAnalysis(data);
            aiText = aiRes.text;
            aiProvider = aiRes.provider;
        } catch (aiError) {
            console.error('🚨 Обидва AI-сервіси (Gemini та Groq) недоступні після всіх спроб! Запис у PENDING...', aiError.message);
            
            // 2. ФОЛБЕК: Додаємо у БД зі статусом PENDING
            await prisma.reportQueue.create({
                data: {
                    prompt: JSON.stringify(data),
                    status: 'PENDING'
                }
            });

            aiText = '⚠️ AI-аналітик тимчасово недоступний через високе навантаження мережі. Завдання збережено в чергу БД і буде додано автоматично пізніше.';
        }

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
${cleanAiResponse(aiText)}
${aiProvider ? `\n🤖 <i>Згенеровано за допомогою: ${aiProvider}</i>` : ''}`;

        await bot.telegram.sendMessage(process.env.MY_CHAT_ID, reportMessage, { parse_mode: 'HTML' });
        await saveChatMessage(process.env.MY_CHAT_ID, 'model', reportMessage);

    } catch (error) {
        console.error('💥 Помилка відправки авто-звіту:', error);
    }
}, {
    timezone: "Europe/Kyiv"
});

// --- 2. POLLING-КРОН ("Нічний санітар") ---
// Запускається кожні 30 хвилин для розбору накопичених PENDING задач
cron.schedule('*/30 * * * *', async () => {
    try {
        const pendingReports = await prisma.reportQueue.findMany({
            where: { status: 'PENDING' }
        });

        if (pendingReports.length === 0) return;

        console.log(`🧹 Нічний санітар: знайдено ${pendingReports.length} необроблених звітів.`);

        for (const report of pendingReports) {
            try {
                const dailyData = JSON.parse(report.prompt);
                
                // Пробуємо обробити
                const aiRes = await generateDailyAiAnalysis(dailyData);

                const reportMessage = 
`🔄 <b>ДОДОПРАЦЬОВАНИЙ AI-АНАЛІЗ ЗВІТУ (з черги БД)</b>
━━━━━━━━━━━━━━━━━━
🤖 <b>AI-Аналітик:</b>
${cleanAiResponse(aiRes.text)}

🤖 <i>Згенеровано за допомогою: ${aiRes.provider}</i>`;

                await bot.telegram.sendMessage(process.env.MY_CHAT_ID, reportMessage, { parse_mode: 'HTML' });
                await saveChatMessage(process.env.MY_CHAT_ID, 'model', reportMessage);

                // Тільки при УСПІХУ змінюємо статус на DONE
                await prisma.reportQueue.update({
                    where: { id: report.id },
                    data: { status: 'DONE' }
                });

                console.log(`✅ Завдання #${report.id} успішно оброблено санітаром.`);
            } catch (itemError) {
                console.warn(`⏳ Завдання #${report.id} не вдалося обробити цього разу: ${itemError.message}`);
            }
        }
    } catch (error) {
        console.error('Помилка виконання Polling-крону ("Нічний санітар"):', error);
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
            { command: 'undo', description: '🔄 Скасувати останню операцію (Ctrl+Z)' },
            { command: 'monthly', description: '🔥 Глибокий AI-аудит за місяць' },
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

// --- AI-РОУТЕР/КЛАСИФІКАТОР НАМІРІВ ---
async function classifyUserIntent(userText) {
    const prompt = `Ти — розумний класифікатор намірів для фінансового бота.
Проаналізуй текст користувача: "${userText}".

Твоє завдання — визначити intent (TRANSACTION, SYNC, CHAT).

ВАРІАНТИ INTENT:
1. "SYNC" — якщо користувач вказує поточний реальний факт на балансі/картці (наприклад: "по факту на карті 4500", "баланс 3200 грн").
2. "TRANSACTION" — якщо в тексті є одна АБО КІЛЬКА фінансових дій/витрат/переказів/боргів.
3. "CHAT" — якщо це запитання, розмова, аналіз ("привіт", "порадь куди вкласти").

ЯКЩО INTENT = "TRANSACTION":
Поверни масив "transactions" з усіма фінансовими діями, розбитими на окремі об'єкти.
Для КОЖНОЇ дії визнач:
- amount: число
- type: "expense" | "income" | "transfer" | "saving" | "i_owe" | "owe_me" | "pay_debt" | "get_debt"
- source: "card" | "cash"
- toSource: "card" | "cash" | null
- category: коротка категорія (1-2 слова)
- workspace: "Особисте" або "Проєкт"
- description: короткий опис конкретно цієї дії

ПРИКЛАД JSON ДЛЯ MULTI-TRANSACTION:
Текст: "Зняв 1000 грн готівки, купив каву за 60 грн з картки та віддав борг 200 грн"
Відповідь:
{
  "isTransaction": true,
  "intent": "TRANSACTION",
  "transactions": [
    {"amount": 1000, "type": "transfer", "source": "card", "toSource": "cash", "category": "Зняття готівки", "workspace": "Особисте", "description": "Зняття готівки"},
    {"amount": 60, "type": "expense", "source": "card", "toSource": null, "category": "Кава", "workspace": "Особисте", "description": "Купив каву"},
    {"amount": 200, "type": "pay_debt", "source": "card", "toSource": null, "category": "Погашення боргу", "workspace": "Особисте", "description": "Віддав борг"}
  ]
}

ВІДПОВІДАЙ ВИКЛЮЧНО В ФОРМАТІ JSON без додаткових символів чи markdown.`;

    try {
        const { text: textResponse, provider } = await generateTextWithFallback(prompt);
        console.log(`🤖 Intent оброблено через: ${provider}`);
        const cleanJson = textResponse.trim().replace(/```json/g, '').replace(/```/g, '').trim(); 
        return JSON.parse(cleanJson); 
    } catch (e) {
        console.error('Помилка класифікації наміру користувача:', e);
        return { isTransaction: false, intent: "CHAT" };
    }
}

