const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateTextWithFallback(prompt) {
    let rawText;
    let providerName;

    // 1. Спроба через Gemini (Основний канал)
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
        const result = await model.generateContent(prompt);
        rawText = result.response.text();
        providerName = 'Gemini (3.5 Flash)';
    } catch (geminiErr) {
        console.warn('⚠️ Gemini API відмовив (503/Error). Перемикаю на Groq...', geminiErr.message);
        
        // 2. Спроба через Groq (Резервний канал)
        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a JSON extractor. Output ONLY valid JSON object/array without any markdown, introductory or explanation text.' 
                    },
                    { role: 'user', content: prompt }
                ],
                model: 'groq/compound',
            });

            rawText = chatCompletion.choices[0]?.message?.content || '';
            providerName = 'Groq (Compound)';
        } catch (groqErr) {
            console.error('❌ Groq API також відмовив:', groqErr.message);
            throw new Error('ALL_AI_PROVIDERS_DOWN', { cause: groqErr });
        }
    }

    // 🛡 САНІТАР-ПАРСЕР: Витягаємо чисто {...} та захищаємо JSON.parse від базікання AI
    let cleanedText = rawText.trim()
        .replace(/```json/gi, '')
        .replace(/```/g, '');

    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1) {
        cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
    }

    return {
        text: cleanedText,
        provider: providerName
    };
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