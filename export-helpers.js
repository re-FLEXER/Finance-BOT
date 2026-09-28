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
        const typeStr = TYPE_TRANSLATIONS[tx.type] || tx.type;
        const sourceStr = SOURCE_TRANSLATIONS[tx.source] || tx.source;
        
        // 🛡 Огортаємо користувацькі текстові поля в санітайзер від CSV Injection
        const safeCategory = sanitizeForCsv(tx.category || '');
        const safeDescription = sanitizeForCsv(tx.description || '');

        return [
            tx.id,
            `"${dateStr}"`,
            `"${typeStr}"`,
            tx.amount,
            `"${sourceStr}"`,
            `"${safeCategory.replace(/"/g, '""')}"`,
            `"${safeDescription.replace(/"/g, '""')}"`,
            `"${tx.workspace || 'Особисте'}"`
        ];
    });

    // Об'єднуємо заголовки та рядки в єдиний CSV-текст з підтримкою UTF-8 BOM
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    return '\uFEFF' + csvContent; // \uFEFF додає BOM для коректного відображення кирилиці в Excel
}

module.exports = {
    sanitizeForCsv,
    generateCsvReport
};