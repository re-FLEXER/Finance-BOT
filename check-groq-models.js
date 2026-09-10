require('dotenv').config();

async function checkGroqModels() {
    const apiKey = process.env.GROQ_API_KEY;
    const url = 'https://api.groq.com/openai/v1/models';

    console.log("Завантажую список доступних моделей від Groq...");

    if (!apiKey) {
        console.error("❌ Будь ласка, встанови змінну середовища GROQ_API_KEY у файлі .env.");
        return;
    }

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();

        if (data.data) {
            console.log("\n✅ Твоєму ключу доступні такі моделі:");
            data.data.forEach(model => {
                console.log(`👉 ${model.id}`);
            });
        }else {
            console.log("❌ Сталася помилка. Відповідь сервера:", data);
        }
    } catch (error) {
        console.error("Помилка мережі:", error);
    }
}

checkGroqModels();