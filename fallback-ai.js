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
    } catch {
        // 2. Спроба через Groq (Резервний канал)
        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are a JSON extractor for a Ukrainian financial bot. ALL category names MUST be strictly in UKRAINIAN language (e.g. "Продукти", "Алкоголь", "Гігієна", "Підписки"). NEVER output English words for categories. Output ONLY valid JSON.' 
                    },
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

    // 🛡 САНІТАР-ПАРСЕР
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

async function generateChatTextWithFallback(systemInstruction, history, userText) {
    let rawText;
    let providerName;

    try {
        const model = genAI.getGenerativeModel({
            model: 'gemini-3.5-flash',
            systemInstruction
        });
        const chat = model.startChat({ history });
        const result = await chat.sendMessage(userText);
        rawText = result.response.text();
        providerName = 'Gemini (3.5 Flash)';
    } catch {
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

async function generateTextWithRetry(prompt, maxRetries = 5, delayMs = 12000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await generateTextWithFallback(prompt);
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