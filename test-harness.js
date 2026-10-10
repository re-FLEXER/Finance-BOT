const Module = require('module');
const path = require('path');

// ==========================================
// 🧮 МІНІМАЛЬНИЙ DECIMAL ДЛЯ ІЗОЛЬОВАНОГО ТЕСТОВОГО СЕРЕДОВИЩА
// ==========================================
class Decimal {
    constructor(v) { this.v = Number(v); }
    div(x) { return new Decimal(this.v / Number(x.v ?? x)); }
    mul(x) { return new Decimal(Math.round(this.v * Number(x.v ?? x) * 1e8) / 1e8); }
    toDecimalPlaces(dp) { return new Decimal(Math.round(this.v * 10 ** dp) / 10 ** dp); }
    isInteger() { return Number.isInteger(Math.round(this.v * 1e6) / 1e6); }
    abs() { return new Decimal(Math.abs(this.v)); }
    greaterThan(x) { return this.v > Number(x); }
    toNumber() { return this.v; }
}
Decimal.ROUND_HALF_UP = 4;

// ==========================================
// 🗄️ MOCK БАЗИ ДАНИХ І ТРАНЗАКЦІЙ PRISMA
// ==========================================
function makeDb() {
    const rows = []; let seq = 1;
    const match = (r, w = {}) => Object.entries(w).every(([k, v]) => {
        if (k === 'OR') return v.some(c => match(r, c));
        if (v && typeof v === 'object' && !(v instanceof Date)) { if (Array.isArray(v.in)) return v.in.includes(r[k]); return true; }
        return r[k] === v;
    });
    const t = {
        rows,
        create: async ({ data }) => {
            if (data.monoId && rows.some(r => r.monoId === data.monoId)) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
            if (data.amount !== undefined && !Number.isFinite(Number(data.amount))) throw new Error('bad amount');
            const row = { id: seq++, source: 'card', toSource: null, is_deleted: false, batchId: null, monoId: null, description: null, createdAt: new Date(), workspace: 'Особисте', ...data };
            rows.push(row); return { ...row };
        },
        findMany: async ({ where } = {}) => rows.filter(r => match(r, where)).map(r => ({ ...r })),
        findFirst: async ({ where } = {}) => rows.filter(r => match(r, where)).slice(-1).map(r => ({ ...r }))[0] || null,
        findUnique: async ({ where }) => { const r = rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v)); return r ? { ...r } : null; },
        update: async ({ where, data }) => { const r = rows.find(r => r.id === where.id); Object.entries(data).forEach(([k, v]) => { if (v !== undefined) r[k] = v; }); return { ...r }; },
        updateMany: async ({ where, data }) => { rows.filter(r => match(r, where)).forEach(r => Object.assign(r, data)); },
        deleteMany: async ({ where } = {}) => { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1); },
        aggregate: async () => ({ _sum: { amount: 0 } }), groupBy: async () => [],
    };
    const prisma = {
        transaction: t, chatHistory: { create: async () => {}, findMany: async () => [], deleteMany: async () => {} }, reportQueue: { findMany: async () => [], create: async () => {}, deleteMany: async () => {}, update: async () => {} },
        $connect: async () => {}, $queryRaw: async () => [{ '?column?': 1 }],
        $transaction: async (arg) => {
            if (typeof arg === 'function') { const snap = rows.map(r => ({ ...r })); try { return await arg(prisma); } catch (e) { rows.length = 0; snap.forEach(r => rows.push(r)); throw e; } }
            const out = []; for (const p of arg) out.push(await p); return out;
        },
    };
    return prisma;
}

// ==========================================
// 🧪 ПІДМІНА ЗАЛЕЖНОСТЕЙ ТА ЗАВАНТАЖЕННЯ ОБРОБНИКІВ
// ==========================================
module.exports = function load({ ai, env = {} }) {
    const handlers = { commands: {}, on: {}, actions: [], post: {}, get: {}, use: [] };
    const sent = [];
    const prisma = makeDb();
    const handleUpdateCalls = [];
    const mocks = {
        dotenv: { config() {} },
        express: Object.assign(() => ({ use() {}, post: (p, fn) => { handlers.post[p] = fn; }, get: (p, fn) => { handlers.get[p] = fn; }, listen() {} }), { json: () => {} }),
        'node-cron': { schedule() {} },
        telegraf: {
            Telegraf: class { constructor() { this.telegram = { sendMessage: async (...a) => { sent.push(a); }, setMyCommands: async () => {}, setWebhook: async () => {}, deleteMessage: async () => {}, editMessageText: async (...a) => { sent.push(['edit', ...a]); }, sendDocument: async () => {} }; }
                use(fn) { handlers.use.push(fn); } catch() {} start() {} hears() {} action(re, fn) { handlers.actions.push([re, fn]); }
                command(n, fn) { [].concat(n).forEach(x => { handlers.commands[x] = fn; }); } on(e, fn) { handlers.on[e] = fn; } async handleUpdate(b) { handleUpdateCalls.push(b); } },
            Markup: { inlineKeyboard: (x) => ({ kb: x }), button: { callback: (a, b) => ({ a, b }) } },
        },
        '@prisma/client': { PrismaClient: class { constructor() { return prisma; } }, Prisma: { Decimal } },
        './fallback-ai': ai,
    };
    const orig = Module._load;
    Module._load = function (req, parent, isMain) { if (req in mocks) return mocks[req]; return orig.call(this, req, parent, isMain); };
    Object.assign(process.env, { MY_CHAT_ID: '111', MONO_SECRET: 'm'.repeat(40), TELEGRAM_WEBHOOK_SECRET: 't'.repeat(40), BOT_TOKEN: 'tok', PORT: '0' }, env);
    delete process.env.RENDER_EXTERNAL_URL;
    for (const f of ['index.js', 'stats-engine.js', 'monthly-analytics.js']) delete require.cache[path.resolve('./' + f)];
    require('./index.js');
    Module._load = orig;
    // 💬 Створюємо повторно використовуваний mock-контекст Telegram-команд.
    const mkCtx = (text, extra = {}) => ({ from: { id: 111 }, chat: { id: 111, type: 'private' }, message: { text }, replies: [],
        reply(m) { this.replies.push(String(m)); return Promise.resolve({ message_id: 1 }); }, replyWithHTML(m) { this.replies.push(String(m)); return Promise.resolve({ message_id: 1 }); },
        telegram: { editMessageText: async (...a) => { sent.push(['edit', ...a]); }, deleteMessage: async () => {}, sendDocument: async () => {} }, ...extra });
    return { handlers, prisma, sent, mkCtx, handleUpdateCalls };
};
