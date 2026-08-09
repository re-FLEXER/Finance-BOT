require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PrismaClient } = require('@prisma/client');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const prisma = new PrismaClient();
const app = express();

app.use(express.json());

let ADMIN_CHAT_ID = process.env.MY_CHAT_ID; 
const editingState = new Map(); 

// --- 🛡️ БЕЗПЕКА (ФЕЙС-КОНТРОЛЬ) ---
bot.use((ctx, next) => {
    if (ctx.from && ctx.from.id.toString() === process.env.MY_CHAT_ID) {
        return next();
    }
    
    // Блокуємо стороннього користувача
    ctx.reply('🚫 Доступ заборонено. Цей фінансовий асистент є приватним.');
    
    // Відправляємо досьє тобі
    const strangerId = ctx.from?.id || 'Невідомо';
    const strangerName = ctx.from?.first_name || 'Без імені';
    const strangerUsername = ctx.from?.username ? `@${ctx.from.username}` : 'прихований';
    const attemptText = ctx.message?.text || 'Натиснув кнопку або надіслав не текст';

    bot.telegram.sendMessage(
        process.env.MY_CHAT_ID, 
        `⚠️ <b>Спроба несанкціонованого доступу!</b>\n\n` +
        `👤 <b>Хто:</b> ${strangerName} (${strangerUsername})\n` +
        `🆔 <b>ID:</b> <code>${strangerId}</code>\n` +
        `💬 <b>Дія:</b> ${attemptText}`,
        { parse_mode: 'HTML' }
    ).catch(e => console.log('Не вдалося надіслати сповіщення:', e));
});

// --- 📊 ФУНКЦІЯ СТАТИСТИКИ ---
const showStats = async (ctx) => {
    try {
        const allTransactions = await prisma.transaction.findMany();
        if (allTransactions.length === 0) return ctx.reply('📭 Твоя база поки що порожня.');

        let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0; 

        allTransactions.forEach(t => {
            if (t.workspace === 'Проєкт') {
                if (t.type === 'income') wIncome += t.amount;
                if (t.type === 'expense') wExpense += t.amount;
            } else {
                if (t.type === 'income') pIncome += t.amount;
                if (t.type === 'expense') pExpense += t.amount;
                if (t.type === 'saving') pSaving += t.amount;
            }
        });

        const workProfit = wIncome - wExpense; 
        const personalBalance = pIncome - pExpense;

        const message = `📊 <b>ФІНАНСОВА СТАТИСТИКА</b>\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `👤 <b>ОСОБИСТИЙ БЮДЖЕТ</b>\n` +
                        `🟢 <b>Доходи:</b> ${pIncome} грн\n` +
                        `🔴 <b>Витрати:</b> ${pExpense} грн\n` +
                        `🟡 <b>Збереження:</b> ${pSaving} грн\n` +
                        `💳 <b>Залишок:</b> ${personalBalance} грн\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💼 <b>ПРОЄКТИ ТА ФРИЛАНС</b>\n` +
                        `🟢 <b>Доходи:</b> ${wIncome} грн\n` +
                        `🔴 <b>Витрати:</b> ${wExpense} грн\n` +
                        `📈 <b>Чиста рентабельність:</b> ${workProfit} грн`;
        
        ctx.replyWithHTML(message);
    } catch (error) {
        ctx.reply('Вибач, сталася помилка при зчитуванні бази.');
    }
};

// --- 🤖 ТЕЛЕГРАМ ІНТЕРФЕЙС ---
bot.start((ctx) => {
    ADMIN_CHAT_ID = ctx.chat.id;
    ctx.reply('Привіт! Твій фінансовий асистент активований і надійно захищений.', 
        Markup.keyboard([['📊 Статистика', '🧹 Очистити історію']]).resize()
    );
});

bot.command('stats', showStats);
bot.hears('📊 Статистика', showStats);
bot.hears('🧹 Очистити історію', (ctx) => {
    ctx.reply('💡 Натисни 3 крапки (меню) у правому верхньому куті ➔ «Очистити історію». База даних та історія в безпеці!');
});

bot.command('setmono', async (ctx) => {
    const text = ctx.message.text.split(' ');
    if (text.length < 2) return ctx.reply('⚠️ Формат: /setmono https://твій-лінк/monobank');
    
    try {
        const response = await fetch('https://api.monobank.ua/personal/webhook', {
            method: 'POST',
            headers: { 'X-Token': process.env.MONO_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ webHookUrl: text[1] })
        });
        if (response.ok) ctx.reply('✅ Вебхук успішно встановлено в Монобанку!');
        else ctx.reply('❌ Помилка: ' + response.statusText);
    } catch(e) {
        ctx.reply('❌ Сталася помилка під час запиту до Монобанку.');
    }
});

// Обробка натискання кнопки "Уточнити"
bot.action(/edit_(\d+)/, (ctx) => {
    const transactionId = parseInt(ctx.match[1]);
    editingState.set(ctx.from.id, transactionId);
    ctx.answerCbQuery();
    ctx.reply(`✏️ Напиши уточнення для транзакції №${transactionId} (наприклад: "переказ за обід" або "матеріали"):`);
});

// Обробка текстових повідомлень (ШІ, редагування та РАДНИК)
bot.on('text', async (ctx) => {
    ADMIN_CHAT_ID = ctx.chat.id;
    const userText = ctx.message.text;
    if (userText.startsWith('/')) return ctx.reply('🤷‍♂️ Такої команди не існує.');

    // 1. Перевірка режиму редагування транзакції
    if (editingState.has(ctx.from.id)) {
        const transactionId = editingState.get(ctx.from.id);
        editingState.delete(ctx.from.id);

        try {
            const existingTx = await prisma.transaction.findUnique({ where: { id: transactionId } });
            if (!existingTx) return ctx.reply('❌ Транзакцію не знайдено.');

            const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
            const prompt = `Користувач уточнює транзакцію. 
            Сума: ${existingTx.amount} грн. Уточнення: "${userText}".
            Визнач: 1. category. 2. workspace ("Проєкт" або "Особисте"). 3. description. 
            Дай формат JSON: {"category": "...", "workspace": "...", "description": "..."}`;

            const result = await model.generateContent(prompt);
            const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

            await prisma.transaction.update({
                where: { id: transactionId },
                data: { category: aiData.category, workspace: aiData.workspace, description: aiData.description }
            });

            return ctx.replyWithHTML(
                `🔄 <b>Транзакцію №${transactionId} оновлено!</b>\n\n` +
                `📦 <b>Простір:</b> ${aiData.workspace}\n` +
                `🏷 <b>Категорія:</b> ${aiData.category}\n` +
                `📝 <i>Новий опис: ${aiData.description}</i>`
            );
        } catch (e) {
            return ctx.reply('Вибач, сталася помилка при оновленні.');
        }
    }

    // 2. АНАЛІЗ НАМІРУ: Транзакція чи Порада?
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        const classificationPrompt = `
        Ти фінансовий асистент. Проаналізуй повідомлення: "${userText}".
        Визнач type: 
        - "income" (отримав гроші)
        - "expense" (витратив гроші)
        - "saving" (відклав гроші)
        - "advice" (користувач ставить питання, просить поради, сумнівається в покупці, аналізує бюджет)
        - "ignore" (повідомлення без сенсу, просте привітання).
        
        Якщо type не "advice" і не "ignore", обов'язково визнач: workspace ("Проєкт" або "Особисте"), amount (число), category, description.
        Дай формат JSON: {"type": "...", "workspace": "...", "amount": 0, "category": "...", "description": "..."}
        `;
        
        const result = await model.generateContent(classificationPrompt);
        const data = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

        // 3. ЛОГІКА РАДНИКА (Якщо користувач просить пораду)
        if (data.type === 'advice') {
            const waitMsg = await ctx.reply('⏳ <i>Радник занурюється в твою базу даних...</i>', { parse_mode: 'HTML' });
            
            // Збираємо статистику для контексту ШІ
            const allTx = await prisma.transaction.findMany();
            let pIncome = 0, pExpense = 0, pSaving = 0, wIncome = 0, wExpense = 0; 
            allTx.forEach(t => {
                if (t.workspace === 'Проєкт') {
                    if (t.type === 'income') wIncome += t.amount;
                    if (t.type === 'expense') wExpense += t.amount;
                } else {
                    if (t.type === 'income') pIncome += t.amount;
                    if (t.type === 'expense') pExpense += t.amount;
                    if (t.type === 'saving') pSaving += t.amount;
                }
            });

           const advisorPrompt = `
            Ти — особистий фінансовий ментор і стратег користувача. Ти мислиш категоріями капіталу та рентабельності, але розумієш, що гроші існують для того, щоб жити комфортно, а не лише накопичувати.
            
            ПОТОЧНИЙ СТАН БЮДЖЕТУ КОРИСТУВАЧА:
            - Вільні особисті кошти (Залишок): ${pIncome - pExpense} грн.
            - Накопичені збереження: ${pSaving} грн.
            - Чиста рентабельність проєктів: ${wIncome - wExpense} грн.
            
            ЗАПИТ КОРИСТУВАЧА: "${userText}"
            
            ЗАВДАННЯ: Дай зважену, стратегічну, але дружню пораду. Підсвіти ризики, якщо витрата надто велика для поточного бюджету, але не будь диктатором. Запропонуй розумний компроміс або альтернативу. Підтримай користувача.
            
            ВАЖЛИВЕ ТЕХНІЧНЕ ПРАВИЛО: Використовуй ТІЛЬКИ базовий HTML: <b>жирний текст</b> та <i>курсив</i>. ТОБІ КАТЕГОРИЧНО ЗАБОРОНЕНО використовувати теги <h1>, <h2>, <h3>, <li>, <ul> або Markdown (зірочки *, решітки #).
            `;
            
            const adviceResult = await model.generateContent(advisorPrompt);
            
            // Захист від бешкетування Gemini (на випадок, якщо він все ж видасть заборонені теги)
            let safeResponse = adviceResult.response.text()
                .replace(/<h[1-6]>/g, '<b>')
                .replace(/<\/h[1-6]>/g, '</b>\n')
                .replace(/\*/g, '');
            
            
            
            // Видаляємо повідомлення очікування і видаємо вердикт
            await ctx.deleteMessage(waitMsg.message_id);
            return ctx.replyWithHTML(`🎩 <b>ТВІЙ РАДНИК:</b>\n\n${safeResponse}`);
        }

        if (data.type === 'ignore') return ctx.reply('🤔 Це не схоже на фінансову операцію чи запит поради.');

        // 4. Логіка ручного додавання транзакції (якщо це не порада)
        await prisma.transaction.create({ 
            data: { 
                type: data.type, 
                amount: data.amount, 
                category: data.category, 
                description: data.description || "", 
                workspace: data.workspace || "Особисте" 
            } 
        });

        ctx.replyWithHTML(
            `✅ <b>Додано вручну</b>\n\n` +
            `📦 <b>Простір:</b> ${data.workspace}\n` +
            `🏷 <b>Категорія:</b> ${data.category}\n\n` +
            `💵 <b>Сума:</b> ${data.amount} грн\n` +
            `📝 <i>Опис: ${data.description}</i>`
        );
    } catch (e) {
        console.error("Помилка:", e);
        ctx.reply('Вибач, помилка при обробці запиту.');
    }
});

// --- 🏦 СЕРВЕР ДЛЯ МОНОБАНКУ ---
app.get('/monobank', (req, res) => {
    res.status(200).send('Webhook is active!');
});

app.post('/monobank', async (req, res) => {
    res.status(200).send('OK');
    const data = req.body;
    
    if (data.type === 'StatementItem' && ADMIN_CHAT_ID) {
        const item = data.data.statementItem;
        const amount = Math.abs(item.amount / 100);
        const monoType = item.amount > 0 ? 'income' : 'expense';
        const description = item.description;

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
            const prompt = `Проаналізуй транзакцію. Сума: ${amount}, Опис: "${description}", Тип: ${monoType}. Визнач: 1. category. 2. workspace ("Проєкт" або "Особисте"). Дай формат JSON: {"category": "...", "workspace": "..."}`;
            
            const result = await model.generateContent(prompt);
            const aiData = JSON.parse(result.response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim());

            const savedTx = await prisma.transaction.create({
                data: { type: monoType, amount: amount, category: aiData.category, description: description, workspace: aiData.workspace }
            });

            bot.telegram.sendMessage(
                ADMIN_CHAT_ID, 
                `🏦 <b>Монобанк | Автоматично</b>\n\n` +
                `📦 <b>Простір:</b> ${aiData.workspace}\n` +
                `🏷 <b>Категорія:</b> ${aiData.category}\n\n` +
                `💵 <b>Сума:</b> ${amount} грн\n` +
                `📝 <i>Опис: ${description}</i>`, 
                { 
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        Markup.button.callback('✏️ Уточнити', `edit_${savedTx.id}`)
                    ])
                }
            );
        } catch (e) {
            console.error("Помилка AI для Моно:", e);
        }
    }
});

app.listen(3000, () => console.log('Слухач Монобанку працює на порту 3000!'));
bot.launch().then(() => console.log('Бот запущенний та повністю готовий до роботи!'));

process.once('SIGINT', async () => { await prisma.$disconnect(); bot.stop('SIGINT'); });
process.once('SIGTERM', async () => { await prisma.$disconnect(); bot.stop('SIGTERM'); });