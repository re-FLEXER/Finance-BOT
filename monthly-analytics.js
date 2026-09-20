const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * 1. Утиліта для отримання часових проміжків
 */
function getMonthRanges() {
    const now = new Date();

    // Поточний місяць
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const endOfCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Попередній місяць
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    return {
        currentMonth: { start: startOfCurrentMonth, end: endOfCurrentMonth },
        previousMonth: { start: startOfPreviousMonth, end: endOfPreviousMonth }
    };
}

/**
 * 2. Основна функція агрегації даних для /monthly
 */
async function getMonthlyAnalyticsData() {
    const { currentMonth, previousMonth } = getMonthRanges();

    // --- БАЗОВІ МЕТРИКИ ЗА ПОТОЧНИЙ МІСЯЦЬ ---
    const [incomeAgg, expenseAgg, savingAgg] = await Promise.all([
        prisma.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'income', is_deleted: false, createdAt: { gte: currentMonth.start, lte: currentMonth.end } }
        }),
        prisma.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'expense', is_deleted: false, createdAt: { gte: currentMonth.start, lte: currentMonth.end } }
        }),
        prisma.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'saving', is_deleted: false, createdAt: { gte: currentMonth.start, lte: currentMonth.end } }
        })
    ]);

    const income = incomeAgg._sum.amount || 0;
    const expense = expenseAgg._sum.amount || 0;
    const savings = savingAgg._sum.amount || 0;
    const delta = income - expense;

    // --- БОРГИ (ПОТОЧНИЙ СТАН В БАЗІ) ---
    const [iOweAgg, payDebtAgg, oweMeAgg, getDebtAgg] = await Promise.all([
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'i_owe', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'pay_debt', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'owe_me', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'get_debt', is_deleted: false } })
    ]);

    const myDebt = (iOweAgg._sum.amount || 0) - (payDebtAgg._sum.amount || 0); // Скільки я винен
    const debtToMe = (oweMeAgg._sum.amount || 0) - (getDebtAgg._sum.amount || 0); // Скільки мені винні

    // --- ПОТОЧНІ БАЛАНСИ (КАРТКА ТА КЕШ) ---
    const [cardInc, cardExp, cashInc, cashExp] = await Promise.all([
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'income', source: 'card', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'expense', source: 'card', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'income', source: 'cash', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'expense', source: 'cash', is_deleted: false } })
    ]);

    const cardBalance = (cardInc._sum.amount || 0) - (cardExp._sum.amount || 0);
    const cashBalance = (cashInc._sum.amount || 0) - (cashExp._sum.amount || 0);
    const totalCapital = cardBalance + cashBalance + savings;

    // --- 3. ТОП-10 КАТЕГОРІЙ ЗА ПОТОЧНИЙ МІСЯЦЬ ---
    const currentTopCategories = await prisma.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        where: {
            type: 'expense',
            is_deleted: false,
            createdAt: { gte: currentMonth.start, lte: currentMonth.end }
        },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10
    });

    // --- 4. КАТЕГОРІЇ ЗА МИНУЛИЙ МІСЯЦЬ ДЛЯ ТРЕНД-АНАЛІЗУ ---
    const previousTopCategories = await prisma.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        where: {
            type: 'expense',
            is_deleted: false,
            createdAt: { gte: previousMonth.start, lte: previousMonth.end }
        }
    });

    // Мапимо минулий місяць у зручний об'єкт { CategoryName: Amount }
    const prevMap = {};
    previousTopCategories.forEach(item => {
        prevMap[item.category] = item._sum.amount || 0;
    });

    // Формуємо фінальний ТОП-10 з обчисленою різницею (Trend Analysis)
    const topCategoriesWithTrend = currentTopCategories.map(item => {
        const catName = item.category;
        const currentAmount = item._sum.amount || 0;
        const previousAmount = prevMap[catName] || 0;
        const diff = currentAmount - previousAmount;

        return {
            category: catName,
            amount: currentAmount,
            prevAmount: previousAmount,
            diff: diff, // Позитивне значення = збільшення витрат, негативне = зменшення
            diffPercentage: previousAmount > 0 ? ((diff / previousAmount) * 100).toFixed(1) : null
        };
    });

    return {
        isFirstMonth: previousTopCategories.length === 0,
        metrics: {
            income,
            expense,
            delta,
            savings,
            myDebt,
            debtToMe,
            cardBalance,
            cashBalance,
            totalCapital
        },
        topCategories: topCategoriesWithTrend
    };
}

module.exports = {
    getMonthlyAnalyticsData
};