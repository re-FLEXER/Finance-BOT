const { prisma, getStatsData } = require('./stats-engine');

/**
 * 📅 Обчислює повні календарні межі поточного та попереднього місяців.
 * Межі включають першу мить першого дня та останню мить останнього дня.
 * @returns {{currentMonth: {start: Date, end: Date}, previousMonth: {start: Date, end: Date}}} Межі обох періодів.
 */
function getMonthRanges() {
    const now = new Date();

    // 🗓️ Поточний період: від початку цього місяця до його останньої мілісекунди.
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const endOfCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // 🗓️ Попередній період: повний календарний місяць перед поточним.
    const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    return {
        currentMonth: { start: startOfCurrentMonth, end: endOfCurrentMonth },
        previousMonth: { start: startOfPreviousMonth, end: endOfPreviousMonth }
    };
}

/**
 * 📊 Збирає показники поточного місяця, залишки, борги та динаміку категорій.
 * Для кожної поточної категорії порівнює витрати з повним попереднім місяцем;
 * isFirstMonth буде true, якщо за попередній період немає витратних категорій.
 * @returns {Promise<{isFirstMonth: boolean, metrics: object, topCategories: Array<object>}>} Дані для місячного аудиту.
 */
async function getMonthlyAnalyticsData() {
    const { currentMonth, previousMonth } = getMonthRanges();

    // 📊 Базові доходи, витрати та заощадження лише за поточний місяць.
    const [incomeAgg, expenseAgg, savingAgg, globalStats] = await Promise.all([
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
        }),
        getStatsData()
    ]);

    const income = incomeAgg._sum.amount || 0;
    const expense = expenseAgg._sum.amount || 0;
    const savings = savingAgg._sum.amount || 0;
    const delta = income - expense;

    // 🤝 Борги рахуються за всю історію, щоб показати актуальний залишок.
    const [iOweAgg, payDebtAgg, oweMeAgg, getDebtAgg] = await Promise.all([
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'i_owe', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'pay_debt', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'owe_me', is_deleted: false } }),
        prisma.transaction.aggregate({ _sum: { amount: true }, where: { type: 'get_debt', is_deleted: false } })
    ]);

    const myDebt = (iOweAgg._sum.amount || 0) - (payDebtAgg._sum.amount || 0); // Скільки я винен
    const debtToMe = (oweMeAgg._sum.amount || 0) - (getDebtAgg._sum.amount || 0); // Скільки мені винні

    const cardBalance = globalStats.personalBalance;
    const cashBalance = globalStats.cashBalance;
    const totalCapital = globalStats.totalCapital;

    // 🏆 Десять найбільших категорій витрат поточного місяця.
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

    // 📈 Витрати попереднього повного місяця для порівняння трендів.
    const previousTopCategories = await prisma.transaction.groupBy({
        by: ['category'],
        _sum: { amount: true },
        where: {
            type: 'expense',
            is_deleted: false,
            createdAt: { gte: previousMonth.start, lte: previousMonth.end }
        }
    });

    // 🗂️ Зводимо попередні суми за назвою категорії для швидкого зіставлення.
    const prevMap = {};
    previousTopCategories.forEach(item => {
        prevMap[item.category] = item._sum.amount || 0;
    });

    // 📉 Додаємо до поточного рейтингу різницю та відсоток зміни проти минулого місяця.
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