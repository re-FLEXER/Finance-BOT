/* eslint-disable preserve-caught-error */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Groq = require("groq-sdk");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function callGroq(prompt, systemInstruction = '') {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });

    const completion = await groq.chat.completions.create({
        messages: messages,
        model: 'llama-3.3-70b-versatile', // 👈 Виправлено назву моделі
        temperature: 0.2,
    });
    return completion.choices[0]?.message?.content || '';
}

async function generateTextWithFallback(prompt, systemInstruction = '') {
    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-3.5-flash",
            systemInstruction: systemInstruction || undefined,
        });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (geminiError) {
        console.warn("⚠️ Gemini API відмовив (503/Error). Перемикаю на Groq (Llama 3)...", geminiError.message);
        try {
            const groqResponse = await callGroq(prompt, systemInstruction);
            return groqResponse.trim();
        } catch (groqError) {
            console.error("❌ Groq API також відмовив. Неможливо отримати відповідь.", groqError.message);
            throw new Error('ALL_AI_PROVIDERS_DOWN');
        }
    }
}

module.exports = { generateTextWithFallback };