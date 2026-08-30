require('dotenv').config();

async function checkModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    console.log("Завантажую список доступних моделей від Google...");

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.models) {
            console.log("\n✅ Твоєму ключу доступні такі моделі:");
            data.models.forEach(model => {
                // Відфільтровуємо лише ті моделі, які вміють генерувати текст
                if (model.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`👉 ${model.name.replace('models/', '')}`);
                }
            });
        } else {
            console.log("❌ Сталася помилка. Відповідь сервера:", data);
        }
    } catch (error) {
        console.error("Помилка мережі:", error);
    }
}

checkModels();