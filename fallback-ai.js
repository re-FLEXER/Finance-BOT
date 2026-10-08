const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GEMINI_REQUEST_OPTIONS = { timeout: 30000 };

/**
 * ⏳ Робить паузу перед наступною спробою запиту.
 * @param {number} ms — тривалість паузи в мілісекундах.
 * @returns {Promise<void>} Обіцянка, що виконується після завершення паузи.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 🤖 Запитує структуровану відповідь у Gemini та за помилки перемикається на Groq.
 * Санітар очищає обгортки розмітки й залишає зовнішній об'єкт JSON, якщо модель
 * додала до нього сторонній текст.
 * @param {string} prompt — текст запиту для обох ШІ-провайдерів.
 * @param {{json?: boolean}} [options] — чи очікується структурована відповідь JSON.
 * @returns {Promise<{text: string, provider: string}>} Очищена відповідь і назва провайдера.
 */
async function generateTextWithFallback(prompt, { json = true } = {}) {
    let rawText;
    let providerName;

    // 🤖 Спочатку звертаємося до Gemini; помилку фіксуємо перед переходом на Groq.
    try {
        const modelConfig = {
            model: 'gemini-3.5-flash',
            ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
        };
        const model = genAI.getGenerativeModel(modelConfig, GEMINI_REQUEST_OPTIONS);
        const result = await model.generateContent(prompt);
        rawText = result.response.text();
        providerName = 'Gemini (3.5 Flash)';
    } catch (geminiErr) {
        console.error('🚨 [AI FALLBACK] Помилка виклику Gemini (gemini-3.5-flash):', {
            message: geminiErr.message,
            status: geminiErr.status || geminiErr.statusCode || 'N/A',
            stack: geminiErr.stack
        });
        // 🔁 Groq підхоплює запит, якщо Gemini недоступна або відхилила його.
        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    ...(json ? [{
                        role: 'system',
                        content: 'You are a JSON extractor for a Ukrainian financial bot. ALL category names MUST be strictly in UKRAINIAN language (e.g. "Продукти", "Алкоголь", "Гігієна", "Підписки"). NEVER output English words for categories. Output ONLY valid JSON.'
                    }] : []),
                    { role: 'user', content: prompt }
                ],
                model: 'openai/gpt-oss-120b',
            });

            rawText = chatCompletion.choices[0]?.message?.content || '';
            providerName = 'Groq (GPT-OSS-120B)';
        } catch (groqErr) {
            throw new Error('ALL_AI_PROVIDERS_DOWN', { cause: groqErr });
        }
    }

    // 🧹 Прибираємо обгортки розмітки та виділяємо дані JSON для подальшого розбору.
    let cleanedText = rawText.trim();

    if (json) {
        cleanedText = cleanedText
            .replace(/```json/gi, '')
            .replace(/```/g, '');

        const firstBrace = cleanedText.indexOf('{');
        const lastBrace = cleanedText.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace !== -1) {
            cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
        }
    }

    return {
        text: cleanedText,
        provider: providerName
    };
}

/**
 * 💬 Веде розмову через Gemini та непомітно переходить на Groq у разі помилки.
 * @param {string} systemInstruction — спільні настанови для розмови.
 * @param {Array<{role: string, parts: Array<{text?: string}>}>} history — попередні повідомлення у форматі Gemini.
 * @param {string} userText — поточне повідомлення користувача.
 * @returns {Promise<{text: string, provider: string}>} Текст відповіді та назва провайдера.
 */
async function generateChatTextWithFallback(systemInstruction, history, userText) {
    let rawText;
    let providerName;

    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-3.5-flash',
            systemInstruction
        }, GEMINI_REQUEST_OPTIONS);
        const chat = model.startChat({ history });
        const result = await chat.sendMessage(userText);
        rawText = result.response.text();
        providerName = 'Gemini (3.5 Flash)';
    } catch (geminiErr) {
        console.error('🚨 [AI FALLBACK] Помилка виклику Gemini (gemini-3.5-flash):', {
            message: geminiErr.message,
            status: geminiErr.status || geminiErr.statusCode || 'N/A',
            stack: geminiErr.stack
        });
        try {
            const messages = [
                { role: 'system', content: systemInstruction },
                ...history.map((message) => ({
                    role: message.role === 'model' ? 'assistant' : message.role,
                    content: message.parts.map((part) => part.text || '').join('')
                })),
                { role: 'user', content: userText }
            ];
            const chatCompletion = await groq.chat.completions.create({
                messages,
                model: 'openai/gpt-oss-120b'
            });

            rawText = chatCompletion.choices[0]?.message?.content || '';
            providerName = 'Groq (GPT-OSS-120B)';
        } catch (groqErr) {
            throw new Error('ALL_AI_PROVIDERS_DOWN', { cause: groqErr });
        }
    }

    return {
        text: rawText,
        provider: providerName
    };
}

/**
 * 🔄 Повторює повний ланцюжок запитів до провайдерів після тимчасових збоїв.
 * @param {string} prompt — текст запиту для ШІ-провайдерів.
 * @param {number} [maxRetries=5] — найбільша кількість спроб.
 * @param {number} [delayMs=12000] — пауза між спробами в мілісекундах.
 * @param {{json?: boolean}} [options] — налаштування формату відповіді для провайдерів.
 * @returns {Promise<{text: string, provider: string}>} Перша успішна відповідь провайдера.
 * @throws {Error} Якщо всі спроби завершилися невдало.
 */
async function generateTextWithRetry(prompt, maxRetries = 5, delayMs = 12000, options = {}) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await generateTextWithFallback(prompt, options);
            return result;
        } catch (err) {
            if (attempt === maxRetries) {
                throw new Error(`Не вдалося отримати відповідь від AI після ${maxRetries} спроб.`, { cause: err });
            }
            await sleep(delayMs);
        }
    }
}

module.exports = {
    generateTextWithFallback,
    generateChatTextWithFallback,
    generateTextWithRetry
};