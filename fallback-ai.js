/* eslint-disable preserve-caught-error */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Допоміжна функція для запиту до Groq (Llama 3)
async function callGroq(prompt, systemInstruction = '') {
    const messages = [];
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    const completion = await groq.chat.completions.create({
        messages: messages,
        model: 'llama3-70b-8192',
        temperature: 0.2,
    });
    return completion.choices[0]?.message?.content || '';
}

// --- Універсальний адаптер генерації тексту (Gemini => Groq) ---
async function generateTextWithFallback(prompt, systemInstruction = '') {
    // 1. Спроба через Gemini
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash",
            systemInstruction: systemInstruction || undefined,
        });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (geminiError) {
        console.warn("⚠️ Gemini API відмовив (503/Error). Перемикаю на Groq (Llama 3)...", geminiError.message);

        // 2. Спроба через Groq (резервний варіант)
        try {
            const groqResponse = await callGroq(prompt, systemInstruction);
            return groqResponse.trim();
        } catch (groqError) {
            console.error("❌ Groq API також відмовив. Неможливо отримати відповідь.", groqError.message);
            throw new Error('ALL_AI_PROVIDERS_DOWN');
        }
    }
}

module.exports = {
    generateTextWithFallback,
};