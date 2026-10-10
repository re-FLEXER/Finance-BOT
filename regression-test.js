const load = require('./test-harness');
const assert = require('assert');
let pass = 0, fail = 0; const failures = [];

// ==========================================
// 🧰 ТЕСТОВІ ПОМІЧНИКИ ТА ПІДГОТОВКА СЦЕНАРІЇВ
// ==========================================
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; failures.push(name); console.log('  ❌', name, '\n       →', String(e.message).split('\n')[0]); } };
const mkAi = (script) => ({
    generateTextWithFallback: async (p, o) => { const r = script(p, o); if (r instanceof Error) throw r; return { text: typeof r === 'string' ? r : JSON.stringify(r), provider: 'mock' }; },
    generateChatTextWithFallback: async () => ({ text: 'ok', provider: 'mock' }), generateTextWithRetry: async () => ({ text: 'ok', provider: 'mock' }),
});
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));
const res = () => ({ code: null, headersSent: false, status(c) { this.code = c; return this; }, sendStatus(c) { this.code = c; return this; }, send() { return this; } });
const MONO = '/monobank/:secret';
const mono = (id, amount, description, extra = {}) => ({ params: { secret: 'm'.repeat(40) }, ip: '1.1.1.1', get: () => undefined,
    body: { type: 'StatementItem', data: { account: 'a', statementItem: { id, time: 1760000000, description, mcc: 5411, amount, operationAmount: amount, currencyCode: 980, commissionRate: 0, cashbackAmount: 0, balance: 500000, hold: false, ...extra } } } });
const intent = (obj) => mkAi((p) => (/класифікатор намірів/.test(p) ? obj : {}));

(async () => {
  // ==========================================
  // 💰 A. ПЕРЕВІРКА ФОРМАТУ ГРОШОВИХ СУМ
  // ==========================================
  console.log('\nA) Введення сум');
  { const { handlers, mkCtx } = load({ ai: mkAi(() => ({})) });
    for (const cmd of ['/sync 358,36', '/setbalance 450,60', '/debt 12,5 Петро', '/paydebt 100,5', '/withdraw 10,5']) {
      await t(`${cmd} (кома, як у підказці бота)`, async () => { const c = mkCtx(cmd); await handlers.commands[cmd.slice(1).split(' ')[0]](c); assert(!/Формат/.test(c.replies[0] || ''), 'відхилено: ' + (c.replies[0] || '').slice(0, 60)); });
    }
    await t('/sync 358.36 (крапка) працює', async () => { const c = mkCtx('/sync 358.36'); await handlers.commands.sync(c); assert(!/Формат/.test(c.replies[0] || '')); });
    await t('/sync 0 і /setbalance -300', async () => { const a = mkCtx('/sync 0'); await handlers.commands.sync(a); const b = mkCtx('/setbalance -300'); await handlers.commands.setbalance(b); assert(!/Формат/.test(a.replies[0] + b.replies[0])); });
    await t('/debt -5 і 12abc відхиляються', async () => { const a = mkCtx('/debt -5 X'); await handlers.commands.debt(a); const b = mkCtx('/debt 12abc X'); await handlers.commands.debt(b); assert(/Формат/.test(a.replies[0]) && /Формат/.test(b.replies[0])); });
  }

  // ==========================================
  // 🛡️ B. БІЛИЙ СПИСОК І TELEGRAM WEBHOOK
  // ==========================================
  console.log('\nB) Whitelist / Telegram webhook');
  { const { handlers, handleUpdateCalls } = load({ ai: mkAi(() => ({})) });
    const route = handlers.post['/telegram/tok'];
    const r1 = res(); route({ body: { u: 1 }, get: () => undefined }, r1);
    const r2 = res(); route({ body: { u: 2 }, get: () => 't'.repeat(40) }, r2); await tick();
    const r3 = res(); route({ body: { u: 3 }, get: () => 'x'.repeat(40) }, r3);
    await t('без заголовка → 403', () => assert.strictEqual(r1.code, 403));
    await t('невірний секрет → 403', () => assert.strictEqual(r3.code, 403));
    await t('вірний секрет → передається в bot.handleUpdate', () => assert.strictEqual(handleUpdateCalls.length, 1));
    const gate = handlers.use[0]; let passed = false;
    await gate({ from: { id: 111 }, chat: { id: -100, type: 'group' }, message: { text: '/stats' } }, async () => { passed = true; });
    await t('власник у ГРУПІ не проходить', () => assert(!passed));
    await gate({ from: { id: 111 }, chat: { id: 111, type: 'private' }, message: { text: '/stats' } }, async () => { passed = true; });
    await t('власник у приваті проходить', () => assert(passed));
  }
  { const { handlers } = load({ ai: mkAi(() => ({})), env: { TELEGRAM_WEBHOOK_SECRET: '' } });
    const r = res(); handlers.post['/telegram/tok']({ body: {}, get: () => undefined }, r);
    await t('[попередження, а не баг] без TELEGRAM_WEBHOOK_SECRET усі апдейти Telegram → 403', () => assert.strictEqual(r.code, 403));
  }

  // ==========================================
  // 🏦 C. MONOBANK: ВАЛІДАЦІЯ ТА ІДЕМПОТЕНТНІСТЬ
  // ==========================================
  console.log('\nC) Вебхук Monobank');
  { const { handlers, prisma } = load({ ai: mkAi(() => ({ type: 'expense', category: 'Продукти', workspace: 'Особисте' })) });
    const r = res(); await handlers.post[MONO](mono('a1', -25000, 'Сільпо'), r); await tick();
    await t('звичайна витрата: 200, запис, createdAt=час події банку', () => { const row = prisma.transaction.rows.find(x => x.monoId === 'a1'); assert.strictEqual(r.code, 200); assert.strictEqual(row.category, 'Продукти'); assert.strictEqual(row.createdAt.getTime(), 1760000000000); assert.strictEqual(row.amount, 250); });
    const r2 = res(); await handlers.post[MONO](mono('a1', -25000, 'Сільпо'), r2);
    await t('дубль → 200, без другого запису', () => { assert.strictEqual(r2.code, 200); assert.strictEqual(prisma.transaction.rows.length, 1); });
    const r3 = res(); await handlers.post[MONO]({ ...mono('a2', 1), params: { secret: 'bad' } }, r3);
    await t('невірний секрет → 403', () => assert.strictEqual(r3.code, 403));
    const r4 = res(); const b = mono('a3', -100); delete b.body.data.statementItem.time; await handlers.post[MONO](b, r4);
    await t('без поля time → 400 (операція не збережена)', () => { assert.strictEqual(r4.code, 400); });
    const r5 = res(); await handlers.post[MONO]({ ...mono('x'), body: { type: 'Ping' } }, r5);
    await t('інший type → 200', () => assert.strictEqual(r5.code, 200));
  }
  { // AI підсовує saving на ЗАРАХУВАННЯ
    const { handlers, prisma } = load({ ai: mkAi(() => ({ type: 'saving', category: 'Банка', workspace: 'Особисте' })) });
    const r = res(); await handlers.post[MONO](mono('b1', 50000, 'Переказ від Іри'), r); await tick();
    await t('зарахування НЕ може стати saving (картка мала б зменшитись замість зрости)', () => assert.strictEqual(prisma.transaction.rows.find(x => x.monoId === 'b1').type, 'income'));
  }
  { const { handlers, prisma } = load({ ai: mkAi(() => ({ type: 'saving', category: 'Банка', workspace: 'Проєкт' })) });
    const r = res(); await handlers.post[MONO](mono('b2', -100000, 'Поповнення Банки'), r); await tick();
    await t('saving + workspace «Проєкт» від AI → простір «Особисте» (інакше stats ігнорує запис)', () => { const row = prisma.transaction.rows.find(x => x.monoId === 'b2'); assert.strictEqual(row.type, 'saving'); assert.strictEqual(row.workspace, 'Особисте'); });
  }
  { const { handlers, prisma } = load({ ai: mkAi(() => new Error('DOWN')) });
    const r = res(); await handlers.post[MONO](mono('c1', -9900, 'Аптека'), r); await tick();
    await t('AI впав: запис «Загальне» збережений', () => { const row = prisma.transaction.rows.find(x => x.monoId === 'c1'); assert(row && row.category === 'Загальне'); });
    const orig = prisma.transaction.create; prisma.transaction.create = async () => { throw new Error('db'); };
    const r2 = res(); await handlers.post[MONO](mono('c2', -100), r2);
    await t('збій БД → 500 (Monobank повторить)', () => assert.strictEqual(r2.code, 500)); prisma.transaction.create = orig;
  }
  { const { handlers, prisma, mkCtx } = load({ ai: mkAi(() => ({})) });
    const r = res(); await handlers.post[MONO](mono('d1', -100000, 'Зняття готівки', { commissionRate: 1000, mcc: 6011 }), r); await tick();
    const rows = prisma.transaction.rows;
    await t('зняття готівки: переказ 990 + комісія 10, один batchId', () => { assert.strictEqual(rows.length, 2); assert.strictEqual(rows[0].amount, 990); assert.strictEqual(rows[1].amount, 10); assert(rows[0].batchId && rows[0].batchId === rows[1].batchId); });
    await handlers.commands.undo(mkCtx('/undo'));
    await t('/undo скасовує обидва записи', () => assert.strictEqual(prisma.transaction.rows.filter(x => !x.is_deleted).length, 0));
    const r2 = res(); await handlers.post[MONO](mono('d2', 50000, 'Повернення з банкомату', { mcc: 6011 }), r2); await tick();
    await t('ЗАРАХУВАННЯ з mcc 6011 не вважається зняттям', () => assert.strictEqual(prisma.transaction.rows.find(x => x.monoId === 'd2').type, 'income'));
    const r3 = res(); await handlers.post[MONO](mono('d3', 50000, 'Переказ', { mcc: 4829 }), r3); await tick();
    await t('вхідний переказ mcc 4829 записується', () => assert(prisma.transaction.rows.some(x => x.monoId === 'd3')));
    const r4 = res(); await handlers.post[MONO](mono('d4', 50000, 'Депозит: поповнення'), r4); await tick();
    await t('зарахування «депозит» відкидається', () => assert(!prisma.transaction.rows.some(x => x.monoId === 'd4')));
  }
  { // паралельні дублі (Monobank ретрай під час AI)
    const { handlers, prisma } = load({ ai: mkAi(() => ({})) });
    const rs = [res(), res(), res()]; await Promise.all(rs.map(r => handlers.post[MONO](mono('e1', -500, 'Кава'), r))); await tick();
    await t('3 одночасні однакові вебхуки → 1 запис, усі 200', () => { assert.strictEqual(prisma.transaction.rows.filter(x => x.monoId === 'e1').length, 1); assert(rs.every(r => r.code === 200), rs.map(r => r.code).join()); });
  }

  // ==========================================
  // 💬 D. РОЗБІР ТЕКСТУ Й БЕЗПЕЧНЕ СТВОРЕННЯ ОПЕРАЦІЙ
  // ==========================================
  console.log('\nD) Текстовий ввід');
  { const { handlers, prisma, mkCtx } = load({ ai: intent({ isTransaction: true, intent: 'TRANSACTION', transactions: [{ amount: 'abc', type: 'expense', category: 'Кава' }] }) });
    const c = mkCtx('кава'); await handlers.on.text(c);
    await t('сума-сміття → нічого не записано', () => assert.strictEqual(prisma.transaction.rows.length, 0)); }
  { const { handlers, prisma, mkCtx } = load({ ai: intent({ isTransaction: true, intent: 'TRANSACTION', transactions: [{ amount: 100, type: 'expense', category: 'Кава' }, { amount: -5, type: 'expense' }] }) });
    await handlers.on.text(mkCtx('дві')); await t('пакет з поганою операцією → не записується цілком', () => assert.strictEqual(prisma.transaction.rows.length, 0)); }
  { const { handlers, prisma, mkCtx } = load({ ai: intent({ isTransaction: true, intent: 'TRANSACTION', transactions: [{ amount: 1000, type: 'transfer', source: 'card', category: 'Зняття', workspace: 'Особисте' }] }) });
    await handlers.on.text(mkCtx('зняв 1000'));
    await t('transfer без toSource не стає ВИТРАТОЮ (тиха підміна типу)', () => { const r = prisma.transaction.rows[0]; assert(!r || r.type !== 'expense', 'записано як ' + (r && r.type)); }); }
  { const { handlers, prisma, mkCtx } = load({ ai: intent({ isTransaction: true, intent: 'TRANSACTION', transactions: [{ amount: 200, type: 'pay_debt', source: 'card', category: 'Борг', workspace: 'Проєкт' }] }) });
    await handlers.on.text(mkCtx('віддав борг 200'));
    await t('pay_debt з workspace «Проєкт» → «Особисте» (stats ігнорує борги в Проєкті)', () => assert.strictEqual(prisma.transaction.rows[0].workspace, 'Особисте')); }
  { const { handlers, prisma, mkCtx } = load({ ai: intent({ isTransaction: true, intent: 'TRANSACTION', transactions: [{ amount: 10, type: 'bogus', category: 'X' }] }) });
    await handlers.on.text(mkCtx('щось')); await t('невідомий тип не перетворюється мовчки на витрату', () => assert(!prisma.transaction.rows[0] || prisma.transaction.rows[0].type !== 'expense')); }
  { const { handlers, mkCtx } = load({ ai: intent({ intent: 'SYNC', amount: '358,36' }) });
    const c = mkCtx('на карті 358,36'); await handlers.on.text(c);
    await t('SYNC від AI з рядком «358,36»', () => assert(!/Не вдалося перевірити/.test(c.replies[0] || ''), c.replies[0])); }

  // ==========================================
  // ✏️ E. УТОЧНЕННЯ ТА РЕДАГУВАННЯ ОПЕРАЦІЙ
  // ==========================================
  console.log('\nE) «Уточнити»');
  { let reply = {};
    const { handlers, prisma, mkCtx } = load({ ai: mkAi(() => reply) });
    await prisma.transaction.create({ data: { type: 'expense', amount: 100, source: 'cash', category: 'Їжа', description: 'обід' } });
    await prisma.transaction.create({ data: { type: 'transfer', amount: 1000, source: 'card', toSource: 'cash', category: 'Зняття готівки' } });
    await prisma.transaction.create({ data: { type: 'income', amount: 500, category: 'Зарплата', workspace: 'Проєкт' } });
    const editAct = handlers.actions.find(([re]) => String(re).includes('edit_'))[1];
    const edit = async (id, text) => { const c = mkCtx('', { match: [null, String(id)], answerCbQuery: async () => {} }); await editAct(c); await handlers.on.text(mkCtx(text)); };
    reply = { type: 'expense', category: 'Кафе', workspace: 'Особисте' };
    await edit(1, 'кафе'); await t('edit витрати з готівки: source лишається «cash»', () => assert.strictEqual(prisma.transaction.rows[0].source, 'cash', 'тепер: ' + prisma.transaction.rows[0].source));
    reply = { category: 'Знято' };
    await edit(2, 'зняття'); await t('edit переказу: toSource НЕ затирається', () => assert.strictEqual(prisma.transaction.rows[1].toSource, 'cash', 'тепер: ' + prisma.transaction.rows[1].toSource));
    reply = {};
    await edit(3, 'щось'); await t('edit: порожня відповідь AI не затирає категорію і простір', () => { const r = prisma.transaction.rows[2]; assert.strictEqual(r.category, 'Зарплата', 'category=' + JSON.stringify(r.category)); assert.strictEqual(r.workspace, 'Проєкт', 'workspace=' + r.workspace); });
    reply = { type: 'expense', category: 'Х', workspace: 'Особисте' };
    await edit(2, 'це кава'); await t('edit: переказ не можна перетворити на витрату', () => assert.strictEqual(prisma.transaction.rows[1].type, 'transfer', 'type=' + prisma.transaction.rows[1].type));
  }

  // ==========================================
  // 📊 F. СТАТИСТИКА, ЗБЕРЕЖЕННЯ ТА ТОЧНІСТЬ DECIMAL
  // ==========================================
  console.log('\nF) Статистика / /setsavings / Decimal');
  { const { handlers, prisma, mkCtx } = load({ ai: mkAi(() => ({})) });
    await handlers.commands.setsavings(mkCtx('/setsavings 5000')); await handlers.commands.withdraw(mkCtx('/withdraw 500')); await handlers.commands.setsavings(mkCtx('/setsavings 5000'));
    const { getStatsData } = require('./stats-engine');
    await t('/setsavings після /withdraw → 5000', async () => assert.strictEqual((await getStatsData()).pSaving, 5000));
    const dec = (n) => ({ toString: () => String(n), valueOf: () => n, [Symbol.toPrimitive]: () => n });
    prisma.transaction.rows.length = 0;
    await prisma.transaction.create({ data: { type: 'init_balance', amount: dec(1000.1) } }); await prisma.transaction.create({ data: { type: 'expense', amount: dec(0.1) } }); await prisma.transaction.create({ data: { type: 'expense', amount: dec(0.2) } });
    await t('getStatsData без дрейфу копійок (1000.1 − 0.1 − 0.2 = 999.8)', async () => assert.strictEqual((await getStatsData()).cardBalance, 999.8));
    prisma.transaction.rows.length = 0;
    await prisma.transaction.create({ data: { type: 'owe_me', amount: 300 } }); await prisma.transaction.create({ data: { type: 'i_owe', amount: 100 } }); await prisma.transaction.create({ data: { type: 'init_balance', amount: 1000 } });
    const s = await getStatsData();
    await t('чистий капітал = картка(700) + мені винні(300) − я винен(100) = 900', () => assert.strictEqual(s.totalCapital, 900, String(s.totalCapital)));
  }

  // ==========================================
  // 💚 G. ПЕРЕВІРКА ДОСТУПНОСТІ СЕРВЕРА
  // ==========================================
  console.log('\nG) /ping');
  { const { handlers } = load({ ai: mkAi(() => ({})) });
    const r = res(); await handlers.get['/ping']({}, r); await t('/ping 200 коли БД жива і вебхук готовий', () => assert.strictEqual(r.code, 200)); }

  // ==========================================
  // 🧾 ПІДСУМОК ПРОГОНУ Й КОД ЗАВЕРШЕННЯ
  // ==========================================
  console.log(`\nПідсумок: ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log('Впали:\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
