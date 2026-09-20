const { PrismaClient } = require('@prisma/client');
const { Parser } = require('json2csv');

const prisma = new PrismaClient();

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

/**
 * Формує CSV-стрінг із транзакціями
 * @param {boolean} onlyCurrentMonth - якщо true, експортує лише поточний місяць
 */
async function generateTransactionsCsv(onlyCurrentMonth = false) {
    const whereCondition = { is_deleted: false };

    if (onlyCurrentMonth) {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        whereCondition.createdAt = {
            gte: startOfMonth,
            lte: endOfMonth
        };
    }

    const transactions = await prisma.transaction.findMany({
        where: whereCondition,
        orderBy: { createdAt: 'desc' }
    });

    if (transactions.length === 0) {
        return { count: 0, csvBuffer: null };
    }

    // Підготовка даних для CSV
    const formattedData = transactions.map(t => {
        // Форматування дати у YYYY-MM-DD HH:mm (Kyiv Timezone)
        const dateFormatted = new Date(t.createdAt).toLocaleString('uk-UA', {
            timeZone: 'Europe/Kyiv',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        let sourceText = SOURCE_TRANSLATIONS[t.source] || t.source || '💳 Картка';
        if (t.type === 'transfer' && t.toSource) {
            const toText = SOURCE_TRANSLATIONS[t.toSource] || t.toSource;
            sourceText = `${sourceText} ➔ ${toText}`;
        }

        return {
            ID: t.id,
            'Дата': dateFormatted,
            'Тип': TYPE_TRANSLATIONS[t.type] || t.type,
            'Сума (грн)': t.amount,
            'Категорія': t.category || 'Загальне',
            'Простір (Workspace)': t.workspace || 'Особисте',
            'Джерело': sourceText,
            'Опис': t.description || ''
        };
    });

    const fields = ['ID', 'Дата', 'Тип', 'Сума (грн)', 'Категорія', 'Простір (Workspace)', 'Джерело', 'Опис'];
    const json2csvParser = new Parser({ fields, delimiter: ';' }); // Скраплюємо крапкою з комою (стандарт для Excel)
    const csvContent = json2csvParser.parse(formattedData);

    // Додаємо UTF-8 BOM (\uFEFF) для ідеального відображення кирилиці в Excel
    const csvBuffer = Buffer.from('\uFEFF' + csvContent, 'utf-8');

    return {
        count: transactions.length,
        csvBuffer
    };
}

module.exports = {
    generateTransactionsCsv
};