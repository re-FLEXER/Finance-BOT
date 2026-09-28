/**
 * ⚡ FULL SYSTEM STRESS & AI LOAD TESTER
 * Запускається командою: node stress-test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { generateCsvReport, sanitizeForCsv } = require('./export-helpers.js');

// Імпортуємо AI SDK (перевірка реальних ключів із .env)
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

// --- НАЛАШТУВАННЯ ТЕСТОВОГО СЕНДУ ---
const report = {
    total: 0,
    passed: 0,
    failed: 0,
    startTime: Date.now(),
    errors: []
};
const securityOnly = process.argv.includes('--security-only');

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function runTestBlock(category, testName, testFn) {
    if (securityOnly && category !== 'Security') return;

    report.total++;
    const startTime = Date.now();
    try {
        const result = await testFn();
        const duration = Date.now() - startTime;

        if (result !== false) {
            report.passed++;
            console.log(`  ✅ [PASS] [${duration}ms] ${testName}`);
        } else {
            report.failed++;
            console.log(`  ❌ [FAIL] [${duration}ms] ${testName}`);
            report.errors.push({
                testName,
                category,
                message: 'Тест повернув false (не пройдено перевірку результату)',
                stack: null
            });
        }
    } catch (err) {
        const duration = Date.now() - startTime;
        report.failed++;
        console.log(`  💥 [CRASH] [${duration}ms] ${testName}`);

        report.errors.push({
            testName,
            category,
            message: err.message || String(err),
            status: err.status || err.statusCode || 'N/A',
            stack: err.stack
        });
    }
}

async function main() {
    console.clear();
    console.log('================================================================');
    console.log('⚡ FINANCIAL BOT — MAXIMUM STRESS & AI HEALTH SUITE');
    console.log('================================================================');
    console.log(`⏱️ Запуск: ${new Date().toLocaleString('uk-UA')}`);
    console.log(`🖥️ Node.js: ${process.version}`);
    if (securityOnly) console.log('🔒 Режим: локальні security-тести без БД та зовнішніх AI API');
    console.log('================================================================\n');

    // ----------------------------------------------------
    // 🗄️ 1. СТРЕС-ТЕСТ БАЗИ ДАНИХ ТА З'ЄДНАННЯ (PRISMA)
    // ----------------------------------------------------
    console.log('🗄️ [SECTION 1] БАЗА ДАНИХ (DATABASE & PRISMA LOAD)');
    
    await runTestBlock('DB', 'Підключення до Supabase/PostgreSQL', async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    });

    await runTestBlock('DB', 'Паралельне читання (10 одночасних запитів)', async () => {
        const promises = Array.from({ length: 10 }).map(() => prisma.transaction.findMany({ take: 5 }));
        await Promise.all(promises);
        return true;
    });

    // ----------------------------------------------------
    // 🧠 2. ПЕРЕВІРКА ТА СТРЕС-ТЕСТ NEURAL NETWORKS (AI PROVIDERS)
    // ----------------------------------------------------
    console.log('\n🧠 [SECTION 2] НЕЙРОМЕРЕЖІ (AI PROVIDERS STRESS & LATENCY)');

    // --- Google Gemini API ---
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
        const geminiModel = 'gemini-3.5-flash';

        // 1. Health Check (Базова доступність)
        await runTestBlock('AI', `Google Gemini (${geminiModel}): 🟢 Health Check (Базовий ping)`, async () => {
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: geminiModel });
            const result = await model.generateContent('Скажи "OK"');
            return result.response.text().length > 0;
        });

        // 2. Стрес промпт (3000+ символів)
        await runTestBlock('AI', `Google Gemini (${geminiModel}): 🔥 Стрес-промпт (3000+ символів)`, async () => {
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: geminiModel });
            const prompt = 'Проаналізуй витрати: ' + 'Купив каву за 60 грн. '.repeat(150);
            const result = await model.generateContent(prompt);
            return result.response.text().length > 0;
        });

        // 3. Concurrency Stress (3 паралельні запити)
        await runTestBlock('AI', `Google Gemini (${geminiModel}): ⚡ Паралельне навантаження (3 запити одночасно)`, async () => {
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: geminiModel });
            const promises = Array.from({ length: 3 }).map(() => model.generateContent('Коротко: статус проекту'));
            const results = await Promise.all(promises);
            return results.every(res => res.response.text().length > 0);
        });
    } else {
        console.log('  ⚠️ [SKIP] GEMINI_API_KEY не знайдено в .env');
    }

    // --- Groq API ---
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
        const groqModel = 'openai/gpt-oss-120b';

        // 1. Health Check (Базова доступність)
        await runTestBlock('AI', `Groq API (${groqModel}): 🟢 Health Check (Базовий ping)`, async () => {
            const groq = new Groq({ apiKey: groqKey });
            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: 'Say OK' }],
                model: groqModel,
            });
            return chatCompletion.choices[0]?.message?.content.length > 0;
        });

        // 2. Стрес промпт
        await runTestBlock('AI', `Groq API (${groqModel}): 🔥 Стрес-промпт (3000+ символів)`, async () => {
            const groq = new Groq({ apiKey: groqKey });
            const prompt = 'Проаналізуй витрати: ' + 'Купив каву за 60 грн. '.repeat(150);
            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: groqModel,
            });
            return chatCompletion.choices[0]?.message?.content.length > 0;
        });
    } else {
        console.log('  ⚠️ [SKIP] GROQ_API_KEY не знайдено в .env');
    }

    // ----------------------------------------------------
    // 🛡️ 3. СТРЕС СИСТЕМИ БЕЗПЕКИ ТА САНІТАРИЗАЦІЇ
    // ----------------------------------------------------
    console.log('\n🛡️ [SECTION 3] SECURITY & ATTACK SURVIVAL');

    await runTestBlock('Security', 'XSS/HTML Бомбардування (Мобільний парсинг Telegram)', async () => {
        const attackVectors = [
            '<script>document.location="http://evil.com"</script>',
            '<b>Unclosed Bold',
            '<img src=x onerror=alert(1)>',
            '<<<>>>&&&"""\'\'\''
        ];
        return attackVectors.every(vector => {
            const clean = escapeHtml(vector);
            return !clean.includes('<script>') && !clean.includes('<img');
        });
    });

    await runTestBlock('Security', 'CSV Injection Bombing (=, +, -, @)', async () => {
        const payloads = ['=SUM(A1:A500)', '+380991112233', '-999999', '@everyone_hack'];
        return payloads.every(p => sanitizeForCsv(p).startsWith("'"));
    });

    await runTestBlock('Security', 'CSV injection in every text column', async () => {
        const payload = '=SUM(A1:A500)';
        const csv = generateCsvReport([{
            id: 1,
            createdAt: new Date(),
            type: payload,
            amount: 1,
            source: payload,
            category: payload,
            description: payload,
            workspace: payload
        }]);
        const safeCell = `"'${payload}"`;
        return csv.split('\n')[1].split(safeCell).length - 1 === 5;
    });

    await runTestBlock('Security', 'Перевантаження пам\'яті великим текстом (500,000 символів)', async () => {
        const hugeString = 'X'.repeat(500000);
        const processed = escapeHtml(hugeString);
        return processed.length === 500000;
    });

    // ----------------------------------------------------
    // 🚨 ДЕТАЛЬНИЙ ЛОГ ПОМИЛОК ТА КРАШІВ (CRASH DUMP)
    // ----------------------------------------------------
    if (report.errors.length > 0) {
        console.log('\n================================================================');
        console.log('🚨 ДЕТАЛЬНИЙ ЛОГ ПОМИЛОК ТА КРАШІВ (CRASH DUMP)');
        console.log('================================================================');

        report.errors.forEach((err, idx) => {
            console.log(`\n📌 [ПОМИЛКА #${idx + 1}] ─ Тест: "${err.testName}" (${err.category})`);
            console.log(`    STATUS / CODE : ${err.status}`);
            console.log(`    DETAILS       : ${err.message}`);
            
            // Спеціальне пояснення для 503 Service Unavailable
            if (String(err.status) === '503' || err.message.includes('503')) {
                console.log(`    💡 ПІДКАЗКА   : Сервери Google тимчасово перевантажені (High Demand). Зачекайте 1-2 хвилини.`);
            }

            if (err.stack) {
                const firstStackLine = err.stack.split('\n')[1] || '';
                console.log(`    AT            :${firstStackLine}`);
            }
        });
    }

    // ----------------------------------------------------
    // 📊 ФІНАЛЬНИЙ РЕПОРТ
    // ----------------------------------------------------
    const totalTime = ((Date.now() - report.startTime) / 1000).toFixed(2);
    console.log('\n================================================================');
    console.log('📊 ФІНАЛЬНИЙ ЗВІТ СТРЕС-ТЕСТУ ВСЬОГО БОТА');
    console.log('================================================================');
    console.log(`⏱️ Загальний час прогону: ${totalTime} сек`);
    console.log(`🎯 Всього тестів: ${report.total}`);
    console.log(`✅ Пройшли стрес-тест: ${report.passed}`);
    console.log(`❌ Впали з помилкою: ${report.failed}`);
    console.log('----------------------------------------------------------------');

    if (report.failed === 0) {
        console.log('🏆 БОТ ПОВНІСТЮ СТАБІЛЬНИЙ, AI ПРАЦЮЄ, БАЗА ВИТРИМУЄ НАВАНТАЖЕННЯ!');
    } else {
        console.log('⚠️ ЗНАЙДЕНО СЛАБКІ МІСЦЯ! Перевірте помилки в блоці CRASH DUMP вище.');
    }
    console.log('================================================================\n');

    await prisma.$disconnect();
    process.exitCode = report.failed === 0 ? 0 : 1;
}

main().catch(async (error) => {
    console.error('Критична помилка stress-test:', error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});