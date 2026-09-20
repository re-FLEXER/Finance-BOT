const { generateTextWithFallback } = require('./fallback-ai');

/**
 * Формує AI-аудит на основі зібраних аналітичних даних
 */
async function generateMonthlyAudit(analyticsData) {
    const { metrics, topCategories, isFirstMonth } = analyticsData;

    // Готуємо текстову вижимку для промпту
    const categoriesSummary = topCategories.map((c, i) => {
        const trend = c.diffPercentage !== null 
            ? `(зміна: ${c.diff > 0 ? '+' : ''}${c.diff.toFixed(2)} грн, ${c.diffPercentage}%)`
            : '(нова категорія)';
        return `${i + 1}.${c.category}: ${c.amount.toFixed(2)} грн ${trend}`;
    }).join('\n');

    const prompt = `Ти — жорсткий, саркастичний, але конструктивний фінансовий аудитор у стилі популярного YouTube-каналу "Кнопка Аліна".
Твоє завдання — проаналізувати місячний фінансовий звіт користувача та надати жорсткий, тверезий, але корисний аудит.

ТОН ТА СТИЛЬ:
- Прямолінійний, із сарказмом, емоційний, молодіжний сленг.
- Дозволяється доречний жорсткий гумор та гострі вислови (наприклад: "протопив у грубці", "клініка", "дупа", "фінансове харакірі"), якщо цифри погані.
- Якщо людина має борги, але витрачає на Вейп, Фастфуд чи Підписки — рознеси це в тріски.
- Якщо людина віддає борги або заощаджує — похвали за інстинкт самозбереження, але не давай розслаблятися.

ФІНАНСОВІ ДАНІ ЗА МІСЯЦЬ:
- Доходи: ${metrics.income.toFixed(2)} грн
- Витрати: ${metrics.expense.toFixed(2)} грн
- Чиста дельта: ${metrics.delta.toFixed(2)} грн
- Заощаджено за місяць: ${metrics.savings.toFixed(2)} грн
- Мій борг (пасив): ${metrics.myDebt.toFixed(2)} грн
- Загальний капітал: ${metrics.totalCapital.toFixed(2)} грн

ТОП-10 КАТЕГОРІЙ ВИТРАТ (ТА ТРЕНД З МИНУЛОГО МІСЯЦЯ):
${categoriesSummary}

ВИМОГИ ДО ФОРМАТУ ВІДПОВІДІ (ЖОРСТКИЙ JSON):
Поверни ВИНЯТКОВО JSON-об'єкт без markdown-блоків (без \`\`\`json) за такою схемою:
{
  "rating": number (від 1 до 10, де 10 — Баффет плаче, 1 — картонка під мостом),
  "verdict": "короткий точний діагноз-заголовок (1 речення)",
  "roast_section": "детальний рознос витрат, топ-категорій, боргів та дурних звичок",
  "praise_section": "похвала за позитивні зрушення (якщо їх немає, напиши що хвалити ні за що)",
  "action_plan": [
    "конкретний крок 1 на наступний місяць",
    "конкретний крок 2",
    "конкретний крок 3"
  ]
}`;

    try {
        const { text: rawResponse, provider } = await generateTextWithFallback(prompt);
        console.log(`🤖 AI Audit згенеровано через: ${provider}`);

        // Санітар-парсер
        let cleanText = rawResponse.trim()
            .replace(/```json/gi, '')
            .replace(/```/g, '');

        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            cleanText = cleanText.substring(firstBrace, lastBrace + 1);
        }

        const auditJson = JSON.parse(cleanText);
        return { success: true, audit: auditJson, provider };
    } catch (e) {
        console.error('❌ Помилка генерації AI-аудиту:', e);
        return { success: false, error: e.message };
    }
}

module.exports = {
    generateMonthlyAudit
};