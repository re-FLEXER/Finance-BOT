const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Перераховує залишки, заощадження, борги й капітал за активними записами.
 * @returns {Promise<object>} Сукупні показники особистих фінансів і проєктів.
 */
async function getStatsData() {
    const allTransactions = await prisma.transaction.findMany({
        where: { is_deleted: false }
    });

    let initBalance = 0;
    let initSaving = 0;
    let pIncome = 0, pExpense = 0, pSaving = 0, pWithdraw = 0, wIncome = 0, wExpense = 0;
    let iOweTotal = 0, payDebtTotal = 0;
    let oweMeTotal = 0, getDebtTotal = 0;

    let cardBalance = 0;
    let cashBalance = 0;

    allTransactions.forEach(t => {
        const source = t.source || 'card';

        if (t.type === 'init_balance') {
            initBalance += t.amount;
            cardBalance += t.amount;
        } else if (t.type === 'init_saving') {
            initSaving += t.amount;
        } else if (t.type === 'transfer') {
            if (source === 'card' && t.toSource === 'cash') {
                cardBalance -= t.amount;
                cashBalance += t.amount;
            } else if (source === 'cash' && t.toSource === 'card') {
                cashBalance -= t.amount;
                cardBalance += t.amount;
            }
        } else if (t.type === 'withdraw_saving') {
            pWithdraw += t.amount;
            cardBalance += t.amount;
        } else if (t.workspace === 'Проєкт') {
            if (t.type === 'income') {
                wIncome += t.amount;
                if (source === 'cash') cashBalance += t.amount; else cardBalance += t.amount;
            }
            if (t.type === 'expense') {
                wExpense += t.amount;
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            }
        } else {
            if (t.type === 'income') {
                pIncome += t.amount;
                if (source === 'cash') cashBalance += t.amount; else cardBalance += t.amount;
            }
            if (t.type === 'expense') {
                pExpense += t.amount;
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            }
            if (t.type === 'saving') {
                pSaving += t.amount;
                if (source === 'cash') cashBalance -= t.amount; else cardBalance -= t.amount;
            }
            if (t.type === 'i_owe') iOweTotal += t.amount;
            if (t.type === 'pay_debt') {
                payDebtTotal += t.amount;
                cardBalance -= t.amount;
            }
            if (t.type === 'owe_me') {
                oweMeTotal += t.amount;
                cardBalance -= t.amount;
            }
            if (t.type === 'get_debt') {
                getDebtTotal += t.amount;
                cardBalance += t.amount;
            }
        }
    });

    const workProfit = wIncome - wExpense;
    const currentIOwe = iOweTotal - payDebtTotal;
    const currentOweMe = oweMeTotal - getDebtTotal;
    const totalSavings = initSaving + pSaving - pWithdraw;
    const totalCapital = cardBalance + cashBalance + totalSavings;

    return {
        initBalance, pIncome, pExpense, pSaving: totalSavings, wIncome, wExpense,
        currentIOwe, currentOweMe, workProfit, personalBalance: cardBalance, totalCapital,
        iOweTotal, payDebtTotal, cardBalance, cashBalance
    };
}

module.exports = { prisma, getStatsData };
