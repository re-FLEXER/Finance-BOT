// Словник перекладу типів транзакцій
const TYPE_TRANSLATIONS = {
    income: '🟢 Дохід',
    expense: '🔴 Витрата',
    transfer: '🔁 Переказ',
    saving: '🟡 Збереження',
    i_owe: '🤝 Взято в борг (Пасив)',
    owe_me: '🤝 Дано в борг (Актив)',
    pay_debt: '💸 Погашення боргу',
    get_debt: '📥 Повернення боргу',
    init_balance: '🏁 Початковий залишок',
    init_saving: '🏁 Стартове збереження'
};

// Словник перекладу джерел коштів
const SOURCE_TRANSLATIONS = {
    card: '💳 Картка',
    cash: '💵 Готівка'
};

// 🛡 Захист від CSV Formula Injection
function sanitizeForCsv(value) {
    if (typeof value !== 'string') return value;
    const dangerousChars = ['=', '+', '-', '@'];
    const trimmed = value.trim();
    
    if (dangerousChars.some(char => trimmed.startsWith(char))) {
        return `'${value}`; // Додаємо одинарну лапку на початок
    }
    return value;
}

function csvTextCell(value) {
    const safeValue = sanitizeForCsv(String(value ?? ''));
    return `"${safeValue.replace(/"/g, '""')}"`;
}

/**
 * Формує CSV-стрінг із транзакціями
 * @param {Array} transactions - Масив об'єктів транзакцій з БД
 * @returns {string} - Згенерований CSV рядок
 */
function generateCsvReport(transactions) {
    if (!transactions || transactions.length === 0) {
        return '';
    }

    // Заголовки стовпчиків
    const headers = ['ID', 'Дата', 'Тип', 'Сума (грн)', 'Джерело', 'Категорія', 'Опис', 'Простір'];

    // Формуємо рядки даних
    const rows = transactions.map(tx => {
        const dateStr = new Date(tx.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
        const typeStr = TYPE_TRANSLATIONS[tx.type] || tx.type || '';
        const sourceStr = SOURCE_TRANSLATIONS[tx.source] || tx.source || '';

        return [
            tx.id,
            csvTextCell(dateStr),
            csvTextCell(typeStr),
            tx.amount,
            csvTextCell(sourceStr),
            csvTextCell(tx.category),
            csvTextCell(tx.description),
            csvTextCell(tx.workspace || 'Особисте')
        ];
    });

    // Об'єднуємо заголовки та рядки в єдиний CSV-текст з підтримкою UTF-8 BOM
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    return '\uFEFF' + csvContent; // \uFEFF додає BOM для коректного відображення кирилиці в Excel
}

/**
 * Формує повний JSON-дамп таблиць бази даних, зберігаючи всі передані поля.
 * @param {{Transaction: Array, ChatHistory: Array, ReportQueue: Array}} tables — записи моделей Prisma.
 * @returns {string} JSON-дамп у UTF-8-сумісному текстовому форматі.
 */
function generateDatabaseJsonBackup(tables) {
    return JSON.stringify({
        createdAt: new Date().toISOString(),
        tables
    }, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

module.exports = {
    sanitizeForCsv,
    generateCsvReport,
    generateDatabaseJsonBackup
};