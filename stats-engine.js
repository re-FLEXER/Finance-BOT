const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ==========================================
// 📊 ПЕРЕРАХУНОК БАЛАНСІВ І ЧИСТОГО КАПІТАЛУ
// ==========================================
/**
 * Перераховує залишки, заощадження, борги й капітал за активними записами.
 * @returns {Promise<object>} Сукупні показники особистих фінансів і проєктів.
 */
async function getStatsData(client = prisma) {
    // 📥 Завантажуємо лише активні записи; усі суми далі переводимо в копійки.
    const allTransactions = await client.transaction.findMany({
        where: { is_deleted: false }
    });

    // Усі проміжні розрахунки ведемо в цілих копійках, щоб сума Float/Decimal
    // значень не накопичувала похибку двійкової арифметики.
    let initBalance = 0;
    let initSaving = 0;
    let pIncome = 0, pExpense = 0, pSaving = 0, pWithdraw = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0;
    let oweMeTotal = 0, getDebtTotal = 0;

    let cardBalance = 0;
    let cashBalance = 0;

    // 🧮 Розкладаємо транзакції на особисті/проєктні потоки та оновлюємо джерела коштів.
    allTransactions.forEach(t => {
        const amount = Math.round(Number(t.amount) * 100);
        const source = t.source || 'card';

        if (t.type === 'init_balance') {
            initBalance += amount;
            cardBalance += amount;
        } else if (t.type === 'init_saving') {
            initSaving += amount;
        } else if (t.type === 'transfer') {
            if (source === 'card' && t.toSource === 'cash') {
                cardBalance -= amount;
                cashBalance += amount;
            } else if (source === 'cash' && t.toSource === 'card') {
                cashBalance -= amount;
                cardBalance += amount;
            }
        } else if (t.type === 'withdraw_saving') {
            pWithdraw += amount;
            cardBalance += amount;
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') {
                wIncome += amount;
                if (source === 'cash') cashBalance += amount; else cardBalance += amount;
            }
            if (t.type === 'expense') {
                wExpense += amount;
                if (source === 'cash') cashBalance -= amount; else cardBalance -= amount;
            }
        } else {
            if (t.type === 'income') {
                pIncome += amount;
                if (source === 'cash') cashBalance += amount; else cardBalance += amount;
            }
            if (t.type === 'expense') {
                pExpense += amount;
                if (source === 'cash') cashBalance -= amount; else cardBalance -= amount;
            }
            if (t.type === 'saving') {
                pSaving += amount;
                if (source === 'cash') cashBalance -= amount; else cardBalance -= amount;
            }
            if (t.type === 'i_owe') iOweTotal += amount;
            if (t.type === 'pay_debt') {
                payDebtTotal += amount;
                cardBalance -= amount;
            }
            if (t.type === 'owe_me') {
                oweMeTotal += amount;
                cardBalance -= amount;
            }
            if (t.type === 'get_debt') {
                getDebtTotal += amount;
                cardBalance += amount;
            }
        }
    });

    // ⚖️ Виводимо чисті залишки, а потім переводимо копійки назад у гривні.
    const workProfit = wIncome - wExpense;
    const currentIOwe = Math.max(0, iOweTotal - payDebtTotal);
    const currentOweMe = Math.max(0, oweMeTotal - getDebtTotal);
    const totalSavings = initSaving + pSaving - pWithdraw;
    const totalCapital = cardBalance + cashBalance + totalSavings + currentOweMe - currentIOwe;
    const toMoney = cents => cents / 100;

    return {
        initBalance: toMoney(initBalance),
        pIncome: toMoney(pIncome),
        pExpense: toMoney(pExpense),
        pSaving: toMoney(totalSavings),
        wIncome: toMoney(wIncome),
        wExpense: toMoney(wExpense),
        currentIOwe: toMoney(currentIOwe),
        currentOweMe: toMoney(currentOweMe),
        workProfit: toMoney(workProfit),
        personalBalance: toMoney(cardBalance),
        totalCapital: toMoney(totalCapital),
        iOweTotal: toMoney(iOweTotal),
        payDebtTotal: toMoney(payDebtTotal),
        cardBalance: toMoney(cardBalance),
        cashBalance: toMoney(cashBalance)
    };
}

// 📦 Prisma-клієнт і спільний розрахунок для команд, аналітики та звітів.
module.exports = { prisma, getStatsData };
