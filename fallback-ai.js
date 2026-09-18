const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateTextWithFallback(prompt) {
    // 1. Спроба через Gemini
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
        const result = await model.generateContent(prompt);
        return {
            text: result.response.text(),
            provider: 'Gemini (3.5 Flash)'
        };
    } catch (geminiErr) {
        console.warn('⚠️ Gemini API відмовив (503/Error). Перемикаю на Groq...', geminiErr.message);
    }

    // 2. Спроба через Groq
    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'groq/compound',
        });
        return {
            text: chatCompletion.choices[0]?.message?.content || '',
            provider: 'Groq (Compound)'
        };
    } catch (groqErr) {
        console.error('❌ Groq API також відмовив:', groqErr.message);
    }

    throw new Error('ALL_AI_PROVIDERS_DOWN');
}

/**
 * Повторні спроби (Retry/Pending queue) для Cron та важливих запитів
 */
async function generateTextWithRetry(prompt, maxRetries = 5, delayMs = 12000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Спроба генерації AI (${attempt}/${maxRetries})...`);
            const result = await generateTextWithFallback(prompt);
            return result;
        } catch (err) {
            console.warn(`⏳ Усі AI провайдери недоступні (${err.message}). Очікування ${delayMs / 1000} сек перед спробою ${attempt + 1}...`);
            if (attempt === maxRetries) {
                throw new Error(`Не вдалося отримати відповідь від AI після ${maxRetries} спроб.`, { cause: err });
            }
            await sleep(delayMs);
        }
    }
}

module.exports = {
    generateTextWithFallback,
    generateTextWithRetry
};