require('dotenv').config();

// ==========================================
// 🔑 ПЕРЕВІРКА ДОСТУПУ ДО GEMINI ТА СПИСКУ МОДЕЛЕЙ
// ==========================================
async function checkModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('❌ GEMINI_API_KEY не знайдено в середовищі.');
        process.exitCode = 1;
        return;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    console.log('Завантажую список доступних моделей від Google...');

    // 📚 Отримуємо список моделей, доступних для переданого API-ключа.
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const data = await response.json();

        if (data.models) {
            console.log('\n✅ Твоєму ключу доступні такі моделі:');
            data.models.forEach(model => {
                // Відфільтровуємо лише ті моделі, які вміють генерувати текст
                if (model.supportedGenerationMethods?.includes('generateContent')) {
                    console.log(`👉 ${model.name.replace('models/', '')}`);
                }
            });
        } else {
            console.error('❌ Помилка списку моделей:', { status: response.status, response: data });
        }
    } catch (error) {
        console.error('Помилка мережі під час отримання списку моделей:', error.message);
    }

    // 🧪 Перевіряємо не лише доступ до каталогу, а й реальну генерацію тексту.
    console.log('\nПеревіряю реальний виклик gemini-3.6-flash...');
    try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' }, { timeout: 30000 });
        const result = await model.generateContent('Відповідай одним словом: працює.');
        console.log('✅ Gemini виклик успішний:', result.response.text());
    } catch (error) {
        console.error('❌ Реальний виклик Gemini завершився помилкою:', {
            message: error.message,
            status: error.status || error.statusCode || 'N/A',
            details: error.errorDetails || error.details || null,
            stack: error.stack
        });
        process.exitCode = 1;
    }
}

// 🚀 Запускаємо діагностику під час виконання скрипту.
checkModels();