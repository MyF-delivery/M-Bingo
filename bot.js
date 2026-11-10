// ============================================================
// M-BINGO TELEGRAM BOT — MERGED WITH AI AGENT
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const cors        = require('cors');
const axios       = require('axios');
const { Pool }    = require('pg');
const bcrypt      = require('bcryptjs');
const cron        = require('node-cron');
require('dotenv').config();

// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required!'); process.exit(1); }

const API_URL            = process.env.API_URL            || 'https://m-bingo-backend.onrender.com';
const SELF_URL           = process.env.SELF_URL           || 'https://m-bingo-bot.onrender.com';
const GAME_URL           = process.env.GAME_URL           || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID  = process.env.ADMIN_TELEGRAM_ID  || '555508978';
const ADMIN_USERNAME     = process.env.ADMIN_USERNAME     || 'admin';
const ADMIN_PASSWORD     = process.env.ADMIN_PASSWORD     || 'admin123';
const ADMIN_PASSWORD_HASH= process.env.ADMIN_PASSWORD_HASH|| '';
const PORT               = process.env.PORT               || 3000;
const REFERRAL_BONUS     = 20;

// AI agent config
const REPORT_TELEGRAM_ID = process.env.REPORT_TELEGRAM_ID || ADMIN_TELEGRAM_ID;
const PROMO_GROUP_IDS    = (process.env.PROMO_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PROMO_TARGET_GROUP = process.env.PROMO_TARGET_GROUP || '';
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || '';
const AI_MODEL           = process.env.AI_MODEL || 'gpt-4o-mini';
const AUTO_APPROVE_WITHDRAWAL_MAX = Number(process.env.AUTO_APPROVE_WITHDRAWAL_MAX || 0);
const AUTO_PAUSE_THRESHOLD        = Number(process.env.AUTO_PAUSE_THRESHOLD || 1000);
const INVITE_BATCH_SIZE           = Number(process.env.INVITE_BATCH_SIZE || 15);
const INVITE_RUNS_PER_DAY         = Number(process.env.INVITE_RUNS_PER_DAY || 4);
const INVITE_DELAY_MS             = Number(process.env.INVITE_DELAY_MS || 2500);

console.log('🤖 M-BINGO Bot (Merged AI Agent)');

// ============================================================
// DATABASE
// ============================================================
const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      { rejectUnauthorized: false }
});
pool.connect((err) => {
    if (err) console.error('❌ DB error:', err.stack);
    else     console.log('✅ Database connected');
});

// ============================================================
// INVITER
// ============================================================
let inviter;
try {
    inviter = require('./telegram-user-inviter');
    console.log('✅ telegram-user-inviter loaded');
} catch (e) {
    console.warn('⚠️ telegram-user-inviter.js not found — invite/DM commands disabled');
    inviter = {
        init: async () => {}, isReady: () => false, inviteToGroup: async () => false,
        sendDM: async () => false, sendManyDMs: async () => ({ sent: 0, failed: 0 }), getContacts: async () => [],
    };
}

// ============================================================
// HELPERS & STATE
// ============================================================
function escapeHtml(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function formatCurrency(amount) {
    return Number(amount || 0).toLocaleString('en-US') + ' ETB';
}
function normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/[^0-9]/g, '');
    if (cleaned.startsWith('251')) cleaned = '0' + cleaned.slice(3);
    if (cleaned.length === 9 && !cleaned.startsWith('0')) cleaned = '0' + cleaned;
    return cleaned;
}

const adminStates = {};
const aiBalancesPages = {};
const playerListPages = {};

// ============================================================
// SETTINGS
// ============================================================
async function initSettingsTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_settings (
                key VARCHAR(64) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            INSERT INTO admin_settings (key, value) VALUES
                ('withdrawals_paused', 'false'), ('pause_threshold', $1), ('invite_all_running', 'false'),
                ('invite_last_run_at', ''), ('ai_players_enabled', 'false'), ('ai_cards_per_game', '2'), ('max_ai_players_per_room', '5')
            ON CONFLICT (key) DO NOTHING
        `, [String(AUTO_PAUSE_THRESHOLD)]);
        console.log('✅ admin_settings ready');
    } catch (e) { console.error('initSettingsTable:', e.message); }
}

async function getSetting(k) { const r = await pool.query(`SELECT value FROM admin_settings WHERE key = $1`, [k]); return r.rows[0]?.value; }
async function setSetting(k, v) {
    await pool.query(`INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`, [k, String(v)]);
}

// ============================================================
// AI HELPERS
// ============================================================
async function getAISettings() {
    try {
        const result = await pool.query(`SELECT key, value FROM admin_settings WHERE key IN ('ai_players_enabled', 'ai_cards_per_game', 'max_ai_players_per_room')`);
        const settings = { enabled: false, cards: 2, maxPerRoom: 5 };
        result.rows.forEach(row => {
            if (row.key === 'ai_players_enabled') settings.enabled = row.value === 'true';
            if (row.key === 'ai_cards_per_game') settings.cards = Number(row.value);
            if (row.key === 'max_ai_players_per_room') settings.maxPerRoom = Number(row.value);
        });
        return settings;
    } catch (e) { return { enabled: false, cards: 2, maxPerRoom: 5 }; }
}
async function getAIPlayers() {
    try { return (await pool.query(`SELECT id, first_name AS name, balance FROM users WHERE is_ai = TRUE ORDER BY balance DESC`)).rows; } catch (e) { return []; }
}
async function depositToAI(aiUserId, amount) {
    try {
        const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
        await axios.post(`${API_URL}/api/admin/ai/balance`, { aiUserId, amount, adminId }, { headers: { 'x-admin-id': adminId } });
        return true;
    } catch (e) { return false; }
}

async function showAIMenu(chatId, messageId = null) {
    const settings = await getAISettings();
    const aiPlayers = await getAIPlayers();
    const totalAIBalance = aiPlayers.reduce((s, p) => s + Number(p.balance || 0), 0);
    const text = `🤖 <b>AI Player Management</b>\n\nStatus: ${settings.enabled ? '✅ <b>ENABLED</b>' : '❌ <b>DISABLED</b>'}\n🃏 Cards per AI: <b>${settings.cards}</b>\n👥 Max AI per room: <b>${settings.maxPerRoom}</b>\n🎭 Total AI players: <b>${aiPlayers.length}</b>\n💰 Total AI balance: <b>${formatCurrency(totalAIBalance)}</b>\n\nChoose an option:`;
    const keyboard = { inline_keyboard: [
        [{ text: settings.enabled ? '🔴 Disable AI' : '🟢 Enable AI', callback_data: 'ai_toggle' }],
        [{ text: '🃏 Set Cards per AI', callback_data: 'ai_set_cards' }],
        [{ text: '👥 Set Max AI per Room', callback_data: 'ai_set_max' }],
        [{ text: '💰 AI Balances & Deposit', callback_data: 'ai_balances_0' }],
        [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
    ]};
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard });
        else await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (e) {}
}

async function showAIBalances(chatId, page = 0, messageId = null) {
    let players = await getAIPlayers();
    if (!players || players.length === 0) return bot.sendMessage(chatId, '❌ No AI players found.');
    aiBalancesPages[chatId] = players;
    const totalPages = Math.ceil(players.length / 10);
    if (page < 0) page = 0; if (page >= totalPages) page = totalPages - 1;
    const startIdx = page * 10; const pagePlayers = players.slice(startIdx, startIdx + 10);
    let text = `💰 <b>AI Player Balances</b> (Page ${page + 1}/${totalPages})\n\n`;
    const keyboard = [];
    pagePlayers.forEach((p, index) => {
        text += `${startIdx + index + 1}. <b>${escapeHtml(p.name)}</b> — ${formatCurrency(p.balance)}\n`;
        keyboard.push([{ text: `➕ 500 → ${p.name}`, callback_data: `ai_dep_${p.id}_500_${page}` }, { text: `➕ 1000 → ${p.name}`, callback_data: `ai_dep_${p.id}_1000_${page}` }]);
    });
    const navButtons = [];
    if (page > 0) navButtons.push({ text: '⬅️ Prev', callback_data: `ai_balances_${page - 1}` });
    if (page < totalPages - 1) navButtons.push({ text: 'Next ➡️', callback_data: `ai_balances_${page + 1}` });
    if (navButtons.length > 0) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Back to AI Menu', callback_data: 'ai_menu' }]);
    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (e) { try { await bot.sendMessage(chatId, text, options); } catch (_) {} }
}

// ============================================================
// ADMIN PLAYER LIST (PAGINATED)
// ============================================================
async function showAdminPlayers(chatId, page = 0, messageId = null) {
    try {
        const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
        const response = await axios.get(`${API_URL}/api/admin/players?adminId=${adminId}`);
        const players = response.data;
        const humans = players.filter(p => !p.is_ai);
        playerListPages[chatId] = humans;
        const totalPages = Math.ceil(humans.length / 20) || 1;
        if (page < 0) page = 0; if (page >= totalPages) page = totalPages - 1;
        const startIdx = page * 20; const pagePlayers = humans.slice(startIdx, startIdx + 20);
        let msg = `👥 <b>Registered Players</b> (Page ${page + 1}/${totalPages})\n\n`;
        pagePlayers.forEach((p, i) => {
            const statusIcon = p.status === 'ONLINE' ? '🟢' : '🔴';
            const username = p.username ? ` (@${p.username})` : '';
            msg += `${startIdx + i + 1}. ${statusIcon} <b>${escapeHtml(p.first_name || 'Player')}</b>${username}\n   💰 ${formatCurrency(p.balance)}\n`;
        });
        const keyboard = [];
        const navButtons = [];
        if (page > 0) navButtons.push({ text: '⬅️ Prev', callback_data: `admin_players_${page - 1}` });
        if (page < totalPages - 1) navButtons.push({ text: 'Next ➡️', callback_data: `admin_players_${page + 1}` });
        if (navButtons.length > 0) keyboard.push(navButtons);
        keyboard.push([{ text: '🔙 Back', callback_data: 'admin_panel' }]);
        const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
        if (messageId) await bot.editMessageText(msg, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, msg, options);
    } catch (e) { await bot.sendMessage(chatId, `⚠️ Error fetching players.`); }
}

// ============================================================
// OTHER AI HELPERS
// ============================================================
async function askAI(sys, usr) {
    if (!OPENAI_API_KEY) return null;
    try {
        const r = await axios.post('https://api.openai.com/v1/chat/completions', { model: AI_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0.7, max_tokens: 400 }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        return r.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { return null; }
}
async function getPendingDeposits() { return (await pool.query(`SELECT d.*, u.first_name AS "userName", u.telegram_id AS "userId", u.balance AS "userBalance" FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'PENDING' ORDER BY d.created_at ASC`)).rows; }
async function getPendingWithdrawals() { return (await pool.query(`SELECT w.*, u.first_name AS "userName", u.telegram_id AS "userId", u.balance AS "userBalance" FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = 'PENDING' ORDER BY w.created_at ASC`)).rows; }

const askedDeposits = new Set();
async function notifyAdminAboutDeposit(d) {
    if (askedDeposits.has(d.id)) return;
    askedDeposits.add(d.id);
    const msg = `📥 <b>New Deposit Request</b>\n\n👤 <b>User:</b> ${escapeHtml(d.userName || 'Unknown')}\n🆔 <b>Telegram:</b> ${d.userId}\n💰 <b>Amount:</b> ${Number(d.amount).toLocaleString()} ETB\n🏦 <b>Method:</b> ${escapeHtml(d.method || 'N/A')}\n📝 <b>Ref:</b> ${escapeHtml(d.reference || 'N/A')}\n💼 <b>Balance before:</b> ${Number(d.userBalance).toLocaleString()} ETB\n\nPlease approve:`;
    const keyboard = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `deposit_approve_${d.id}` }, { text: '❌ Reject',  callback_data: `deposit_reject_${d.id}` }]] };
    try { await bot.sendMessage(REPORT_TELEGRAM_ID, msg, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { askedDeposits.delete(d.id); }
}

async function approveWithdrawalAI(id, reason = 'Approved') {
    const c = await pool.connect();
    try {
        await c.query('BEGIN'); const wr = await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [id]);
        if (!wr.rows.length) { await c.query('ROLLBACK'); return false; }
        const w = wr.rows[0]; const u = await c.query(`SELECT balance FROM users WHERE id=$1 FOR UPDATE`, [w.user_id]);
        const before = Number(u.rows[0].balance); if (before < Number(w.amount)) { await c.query('ROLLBACK'); return false; }
        const after = before - Number(w.amount);
        await c.query(`UPDATE users SET balance=$1, withdrawal_reserved=GREATEST(0, COALESCE(withdrawal_reserved,0)-$2) WHERE id=$3`, [after, Number(w.amount), w.user_id]);
        await c.query(`INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,reference_type,reference_id) VALUES ($1,'WITHDRAWAL',$2,$3,$4,'WITHDRAWAL',$5)`, [w.user_id, w.amount, before, after, w.id]);
        await c.query(`UPDATE withdrawals SET status='APPROVED', approved_at=CURRENT_TIMESTAMP, varify_status=$2 WHERE id=$1`, [w.id, reason]);
        await c.query('COMMIT'); return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); return false; } finally { c.release(); }
}

async function rejectWithdrawalAI(id, reason) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN'); const wr = await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [id]);
        if (!wr.rows.length) { await c.query('ROLLBACK'); return false; }
        const w = wr.rows[0];
        await c.query(`UPDATE users SET withdrawal_reserved=GREATEST(0, COALESCE(withdrawal_reserved,0)-$1) WHERE id=$2`, [Number(w.amount), w.user_id]);
        await c.query(`UPDATE withdrawals SET status='REJECTED', rejected_at=CURRENT_TIMESTAMP, rejection_reason=$2 WHERE id=$1`, [w.id, reason]);
        await c.query('COMMIT'); return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); return false; } finally { c.release(); }
}

async function analyzeWithdrawal(w) {
    const sys = `You are a fraud-detection assistant for an Ethiopian bingo app. Respond ONLY with JSON: {"decision":"approve"|"reject"|"review","reason":"short reason"}.`;
    const usr = `Withdrawal:\n- User: ${w.userName} (${w.userId})\n- Amount: ${w.amount} ETB\n- Method: ${w.method}\n- Destination: ${w.destination}\n- Balance: ${w.userBalance} ETB`;
    const raw = await askAI(sys, usr);
    if (!raw) return { decision: 'review', reason: 'AI unavailable' };
    try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return { decision: 'review', reason: 'parse failed' }; }
}

async function generatePromoMessage() {
    const sys = `Write a short exciting Amharic promo for an Ethiopian bingo app. Emojis. Max 3 sentences.`;
    const usr = `Mention: 10 Birr stake, real ETB prizes, 50 Birr bonus for new users. Link: ${GAME_URL}`;
    const m = await askAI(sys, usr);
    return m || `🎯 ቢንጎ ጨዋታ!\n\n💥 10 ብር ብቻ!\n🎁 50 ብር ቦነስ ለአዲስ ተጫዋቾች!\n👉 ${GAME_URL}`;
}
async function postPromotion() {
    if (!PROMO_GROUP_IDS.length) return;
    const msg = await generatePromoMessage();
    for (const g of PROMO_GROUP_IDS) { try { await bot.sendMessage(g, msg, { parse_mode: 'Markdown' }); } catch (e) {} }
}

async function getDailyStats() {
    const q = async (sql) => (await pool.query(sql)).rows[0];
    const s = {};
    s.depositsTotal = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM deposits WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.depositsCount = Number((await q(`SELECT COUNT(*) AS x FROM deposits WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.withdrawalsTotal = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM withdrawals WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.withdrawalsCount = Number((await q(`SELECT COUNT(*) AS x FROM withdrawals WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.commissionTotal = Number((await q(`SELECT COALESCE(SUM(commission_amount),0) AS x FROM commissions WHERE created_at::date=CURRENT_DATE`)).x);
    s.gamesPlayed = Number((await q(`SELECT COUNT(*) AS x FROM commissions WHERE created_at::date=CURRENT_DATE`)).x);
    s.gamePayouts = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM wallet_transactions WHERE type='GAME_WIN' AND created_at::date=CURRENT_DATE`)).x);
    s.newUsers = Number((await q(`SELECT COUNT(*) AS x FROM users WHERE created_at::date=CURRENT_DATE`)).x);
    s.totalUsers = Number((await q(`SELECT COUNT(*) AS x FROM users`)).x);
    s.activeUsers = Number((await q(`SELECT COUNT(DISTINCT user_id) AS x FROM wallet_transactions WHERE created_at::date=CURRENT_DATE`)).x);
    s.pendingDeposits = Number((await q(`SELECT COUNT(*) AS x FROM deposits WHERE status='PENDING'`)).x);
    s.pendingWithdrawals = Number((await q(`SELECT COUNT(*) AS x FROM withdrawals WHERE status='PENDING'`)).x);
    s.netToday = s.depositsTotal - s.withdrawalsTotal + s.commissionTotal - s.gamePayouts;
    return s;
}
async function getNetPosition() {
    const r = await pool.query(`SELECT COALESCE((SELECT SUM(amount) FROM deposits WHERE status='APPROVED'),0) - COALESCE((SELECT SUM(amount) FROM withdrawals WHERE status='APPROVED'),0) AS net`);
    return Number(r.rows[0].net);
}
async function sendDailyReport() {
    try {
        const s = await getDailyStats();
        const net = await getNetPosition();
        const paused = (await getSetting('withdrawals_paused')) === 'true';
        const msg = `📊 <b>M-BINGO DAILY REPORT</b>\n\n💰 Deposits: ${s.depositsTotal.toLocaleString()} ETB (${s.depositsCount})\n📤 Withdrawals: ${s.withdrawalsTotal.toLocaleString()} ETB (${s.withdrawalsCount})\n🏆 Game payouts: ${s.gamePayouts.toLocaleString()} ETB\n💵 Commission: ${s.commissionTotal.toLocaleString()} ETB\n🎮 Games: ${s.gamesPlayed}\n\n👥 New users: ${s.newUsers}\n🔥 Active: ${s.activeUsers}\n📈 Total: ${s.totalUsers}\n\n📉 Net today: ${s.netToday >= 0 ? '+' : ''}${s.netToday.toLocaleString()} ETB\n💼 Net all-time: ${net.toLocaleString()} ETB\n🚨 Withdrawals: ${paused ? '⏸ PAUSED' : '▶ Active'}`;
        await bot.sendMessage(REPORT_TELEGRAM_ID, msg, { parse_mode: 'HTML' });
    } catch (e) {}
}

async function checkAndAutoPause() {
    try {
        const net = await getNetPosition();
        const threshold = Number(await getSetting('pause_threshold') || AUTO_PAUSE_THRESHOLD);
        const paused = (await getSetting('withdrawals_paused')) === 'true';
        if (net < threshold && !paused) { await setSetting('withdrawals_paused', 'true'); await bot.sendMessage(REPORT_TELEGRAM_ID, `🚨 <b>AUTO-PAUSE</b>\nNet ${net.toLocaleString()} ETB\n⏸ Withdrawals PAUSED.`, { parse_mode: 'HTML' }); }
        else if (net >= threshold && paused) { await setSetting('withdrawals_paused', 'false'); await bot.sendMessage(REPORT_TELEGRAM_ID, `✅ <b>AUTO-RESUME</b>\nNet ${net.toLocaleString()} ETB\n▶ Withdrawals ACTIVE.`, { parse_mode: 'HTML' }); }
    } catch (e) {}
}

async function keepAlive() {
    const targets = [{ name: 'Backend', url: `${API_URL}/health` }, { name: 'Self', url: `${SELF_URL}/health` }];
    for (const t of targets) { try { await axios.get(t.url, { timeout: 20000 }); } catch (e) {} }
}

let ADMIN_DB_ID = null;
async function ensureAdminUser() {
    try {
        const result = await pool.query(`SELECT id, is_admin FROM users WHERE telegram_id = $1`, [ADMIN_TELEGRAM_ID]);
        if (result.rows.length === 0) await pool.query(`INSERT INTO users (telegram_id, username, first_name, balance, is_admin, last_login) VALUES ($1, 'admin', 'Admin', 0, TRUE, CURRENT_TIMESTAMP)`, [ADMIN_TELEGRAM_ID]);
        else if (result.rows[0].is_admin !== true) await pool.query(`UPDATE users SET is_admin = TRUE WHERE telegram_id = $1`, [ADMIN_TELEGRAM_ID]);
        const idResult = await pool.query(`SELECT id FROM users WHERE telegram_id = $1 AND is_admin = TRUE`, [ADMIN_TELEGRAM_ID]);
        if (idResult.rows.length) ADMIN_DB_ID = idResult.rows[0].id;
    } catch (error) {}
}
ensureAdminUser();

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());
app.get('/', (req, res) => res.send('M-BINGO Bot is running ✅'));
app.get('/health', async (req, res) => { try { await pool.query('SELECT NOW()'); res.json({ status: 'ok' }); } catch (e) { res.status(500).json({ status: 'error' }); } });
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME) return res.status(401).json({ success: false });
    if (ADMIN_PASSWORD_HASH) { if (!(await bcrypt.compare(password, ADMIN_PASSWORD_HASH))) return res.status(401).json({ success: false }); } 
    else if (password !== ADMIN_PASSWORD) { return res.status(401).json({ success: false }); }
    res.json({ success: true, adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID });
});

// ============================================================
// TELEGRAM BOT & PLAYER HELPERS
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
bot.deleteWebHook().catch(() => {});

async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode, phoneNumber) {
    try { const response = await axios.post(`${API_URL}/api/users/register`, { telegramId, username: username || `user_${telegramId}`, firstName, lastName: lastName || '', referralCode: referralCode || null, phone: phoneNumber }, { headers: { 'X-Bot-Token': BOT_TOKEN } }); return response.data.user; } catch (error) { return null; }
}
async function getUserBalance(telegramId) {
    try { const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`); return response.data.balance || 0; } catch { return 0; }
}

function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
        [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
        [{ text: "🎁 Bonus / Invite", callback_data: 'bonus' }, { text: "📜 History", callback_data: 'history' }],
        [{ text: "📖 Help", callback_data: 'help' }, { text: "📞 Support", callback_data: 'support' }],
        [{ text: "🏆 Patterns", callback_data: 'patterns' }, { text: "👤 Profile", callback_data: 'profile' }]
    ];
    if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    return { reply_markup: { inline_keyboard: buttons } };
}

// ============================================================
// COMMAND HANDLERS
// ============================================================
async function handleStart(msg, match) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    const firstName = escapeHtml(msg.from.first_name || 'Player');
    const lastName  = escapeHtml(msg.from.last_name  || '');
    const username  = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            if (!response.data.user.phoneNumber) {
                await bot.sendMessage(chatId, '⚠️ Your account is missing a phone number. Please share your contact to enable transfers and withdrawals.', { reply_markup: { keyboard: [[{ text: "📱 Share Contact", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
                return;
            }
            const balance = await getUserBalance(userId);
            const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
            const welcomeBack = `👋 <b>Welcome back, ${firstName}!</b>${isAdmin ? ' 👑' : ''}\n\n💰 <b>Balance:</b> ${formatCurrency(balance)}\n📊 <b>Games Played:</b> ${response.data.user.gamesPlayed || 0}\n🏆 <b>Wins:</b> ${response.data.user.wins || 0}\n\n👇 <b>Select an option below:</b>`;
            await bot.sendMessage(chatId, welcomeBack, { parse_mode: 'HTML', ...mainMenu(userId) });
            return;
        }
    } catch (error) {}

    await bot.sendMessage(chatId, `📝 <b>Welcome to M-BINGO, ${firstName}!</b>\n\nTo complete your registration, please share your contact by clicking the button below.`, {
        parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: "📱 Share Contact", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
    bot._referralMap = bot._referralMap || {}; bot._referralMap[userId] = referralId;
}

async function handlePlay(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    let isRegistered = false;
    try { const res = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [userId]); if (res.rows.length > 0) isRegistered = true; } catch (e) {}
    if (!isRegistered) return bot.sendMessage(chatId, '❌ Please register first using /start.');
    const gameUrl = `${GAME_URL}?mode=lobby&userId=${userId}`;
    await bot.sendMessage(chatId, '🎮 <b>Join a game room below:</b>\n\nClick to open the game.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "🎮 Open Game", web_app: { url: gameUrl } }], [{ text: "🔙 Back", callback_data: 'back_to_menu' }]] } });
}

async function handleBalance(msg) { const balance = await getUserBalance(msg.from.id); await bot.sendMessage(msg.chat.id, `💰 <b>Your Balance</b>\n\n${formatCurrency(balance)}`, { parse_mode: 'HTML' }); }

async function handleDeposit(msg) {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🏦 <b>Make a Deposit</b>\n\nPlease enter the amount you wish to deposit (minimum 50 ETB).', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const amount = parseInt(msg2.text); if (isNaN(amount) || amount < 50 || amount > 5000) return bot.sendMessage(chatId, '❌ Invalid amount. Enter 50-5000.');
        await bot.sendMessage(chatId, '💰 <b>Select payment method:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "🏦 CBE Bank", callback_data: `deposit_method_bank_${amount}` }], [{ text: "💳 CBE Birr", callback_data: `deposit_method_cbe_${amount}` }], [{ text: "📱 E-BIRR", callback_data: `deposit_method_ebirr_${amount}` }], [{ text: "❌ Cancel", callback_data: 'cancel' }]] } });
    });
}

async function handleWithdraw(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    await bot.sendMessage(chatId, '📤 <b>Withdrawal</b>\n\nPlease enter the amount you wish to withdraw.', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const amount = parseInt(msg2.text); if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount.');
        const balance = await getUserBalance(userId); if (amount > balance) return bot.sendMessage(chatId, `❌ Insufficient balance. Your balance is ${formatCurrency(balance)}.`);
        await bot.sendMessage(chatId, '🏦 <b>Please enter your withdrawal address</b> (Bank Account or Phone Number):', { parse_mode: 'HTML' });
        bot.once('text', async (msg3) => {
            const address = msg3.text.trim(); if (!address) return;
            try {
                const response = await axios.post(`${API_URL}/api/withdraw/request`, { userId, amount, method: 'cbe_bank', account: address });
                if (response.data.success) await bot.sendMessage(chatId, '⏳ <b>Processing your withdrawal request...</b>\n\nPlease wait for admin approval.', { parse_mode: 'HTML' });
                else await bot.sendMessage(chatId, `❌ ${response.data.message || 'Request failed.'}`);
            } catch { await bot.sendMessage(chatId, '❌ Could not connect to server. Please try again.'); }
        });
    });
}

async function handleTransfer(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    await bot.sendMessage(chatId, '🔄 <b>Transfer Funds</b>\n\nPlease enter the recipient\'s <b>Phone Number</b> (e.g. 0912345678) OR their <b>Telegram ID</b>.', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const input = msg2.text.trim(); let recipientId, recipientName;
        if (/^[0-9+]{10,13}$/.test(input.replace(/\s/g, ''))) {
            const phone = normalizePhone(input);
            try { const response = await axios.get(`${API_URL}/api/users/by-phone/${phone}`); recipientId = response.data.user.id; recipientName = response.data.user.first_name; }
            catch (error) { if (error.response?.status === 404) await bot.sendMessage(chatId, `❌ Phone number <b>${phone}</b> is not registered.\n\n📩 <b>Invite them!</b>\nhttps://t.me/M_bingo_bot?start=ref_${userId}`, { parse_mode: 'HTML' }); else await bot.sendMessage(chatId, `⚠️ Server error.`); return; }
        } else {
            try { const response = await axios.get(`${API_URL}/api/users/${input}`); recipientId = response.data.user.id; recipientName = response.data.user.firstName; }
            catch (error) { return bot.sendMessage(chatId, `❌ User with ID <b>${input}</b> is not registered.`, { parse_mode: 'HTML' }); }
        }
        await bot.sendMessage(chatId, `👤 Recipient: <b>${recipientName}</b>\n\n💵 <b>Enter amount (Max 500 Birr):</b>`, { parse_mode: 'HTML' });
        bot.once('text', async (msg3) => {
            const amount = parseInt(msg3.text); if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount.');
            if (amount > 500) return bot.sendMessage(chatId, '❌ Maximum transfer amount is <b>500 Birr</b>.', { parse_mode: 'HTML' });
            const balance = await getUserBalance(userId); if (amount > balance) return bot.sendMessage(chatId, `❌ Insufficient balance.`);
            try { await axios.post(`${API_URL}/api/transfer`, { fromId: userId, toId: recipientId, amount }); await bot.sendMessage(chatId, `✅ Successfully transferred <b>${formatCurrency(amount)}</b> to ${recipientName}.`, { parse_mode: 'HTML' }); }
            catch (e) { await bot.sendMessage(chatId, `❌ ${e.response?.data?.message || 'Transfer failed.'}`); }
        });
    });
}

async function handleBonus(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id; const inviteLink = `https://t.me/M_bingo_bot?start=ref_${userId}`;
    await bot.sendMessage(chatId, `🎁 <b>Invite Friends & Earn!</b>\n\nShare your unique referral link:\n\n${inviteLink}\n\nFor each friend who registers, you earn <b>${REFERRAL_BONUS} Birr</b>!`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }], [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]] } });
}
async function handleHistory(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/transactions/${userId}`); const txs = response.data.transactions || [];
        if (!txs.length) return bot.sendMessage(chatId, '📜 No transactions found.');
        let msgText = '📜 <b>Your Transaction History</b>\n\n';
        txs.slice(0, 10).forEach(t => { const type = t.type === 'deposit' ? '💰 Deposit' : t.type === 'withdraw' ? '📤 Withdraw' : t.type === 'transfer' ? '🔄 Transfer' : '🎮 Game'; const sign = t.type === 'deposit' ? '+' : '-'; msgText += `${type}: ${sign}${formatCurrency(t.amount)} - ${t.status}\n`; });
        await bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
    } catch { bot.sendMessage(chatId, '⚠️ Could not fetch transactions.'); }
}
async function handleProfile(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`); const user = response.data.user; const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
        const message = `👤 <b>Your Profile</b>${isAdmin ? ' 👑 (Admin)' : ''}\n\n📛 <b>Name:</b> ${escapeHtml(user.firstName || 'Player')}\n🆔 <b>ID:</b> ${user.telegramId}\n💰 <b>Balance:</b> ${formatCurrency(user.balance || 0)}\n🏆 <b>Games Played:</b> ${user.gamesPlayed || 0}\n🎖️ <b>Wins:</b> ${user.wins || 0}\n📅 <b>Joined:</b> ${new Date(user.createdAt).toLocaleDateString()}`;
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch { await bot.sendMessage(chatId, '⚠️ Could not fetch profile.'); }
}
async function handleHelp(msg) {
    const chatId = msg.chat.id; const userId = msg.from.id; const isAdmin = String(userId) === String(ADMIN_TELEGRAM_ID);
    let helpText = `📖 <b>M-BINGO Help</b>\n\n<b>Player Commands:</b>\n/start - Start bot\n/play - Play game\n/balance - Check balance\n/deposit - Deposit funds\n/withdraw - Withdraw funds\n/transfer - Transfer funds\n/myphone - Update phone\n/bonus - Invite friends\n/history - Transactions\n/profile - Profile\n/help - Help\n`;
    if (isAdmin) helpText += `\n<b>Admin Commands:</b>\n/ai_status\n/ai_report\n/ai_pause\n/ai_resume\n/ai_broadcast\n/ai_promo\n/ai_invite_contacts\n`;
    helpText += `\n<b>Support:</b> @frezerabiy`;
    await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
}

// Register commands
bot.onText(/\/start(?:\s+ref_(\d+))?/, handleStart);
bot.onText(/\/play/,     handlePlay);
bot.onText(/\/balance/,  handleBalance);
bot.onText(/\/deposit/,  handleDeposit);
bot.onText(/\/withdraw/, handleWithdraw);
bot.onText(/\/transfer/, handleTransfer);
bot.onText(/\/bonus/,    handleBonus);
bot.onText(/\/history/,  handleHistory);
bot.onText(/\/profile/,  handleProfile);
bot.onText(/\/help/,     handleHelp);
bot.onText(/\/myphone/, async (msg) => { await bot.sendMessage(msg.chat.id, '📱 <b>Update Phone Number</b>\n\nPlease click the button below to share your phone number.', { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: "📱 Share Contact", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }); });

// ============================================================
// CONTACT HANDLER
// ============================================================
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id; const contact = msg.contact;
    const firstName = escapeHtml(msg.from.first_name || 'Player'); const lastName  = escapeHtml(msg.from.last_name  || ''); const username  = msg.from.username || `user_${userId}`;
    if (!contact || contact.user_id != userId) return bot.sendMessage(chatId, '❌ Please share your own contact.');
    const referralId = bot._referralMap ? bot._referralMap[userId] : null; const formattedPhone = normalizePhone(contact.phone_number);
    try {
        let isAlreadyRegistered = false;
        try { if ((await axios.get(`${API_URL}/api/users/${userId}`)).data.user) isAlreadyRegistered = true; } catch (e) {}
        const user = await getOrCreateUser(userId, firstName, lastName, username, referralId, formattedPhone);
        if (user) {
            if (isAlreadyRegistered) {
                await bot.sendMessage(chatId, '✅ <b>Phone number updated successfully!</b>\n\nYou can now use transfers and withdrawals.', { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
                await bot.sendMessage(chatId, '🎯 <b>Welcome back!</b>', { parse_mode: 'HTML', ...mainMenu(userId) });
            } else {
                if (referralId) { try { await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId }); } catch {} }
                await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
                await bot.sendMessage(chatId, `✅ <b>Registration Successful!</b>\n\n🎯 Welcome to M-BINGO, ${firstName}!\n💰 You received a <b>50 Birr</b> starting balance.`, { parse_mode: 'HTML', ...mainMenu(userId) });
            }
        }
    } catch { await bot.sendMessage(chatId, '❌ Registration failed.'); }
});

// ============================================================
// CALLBACK HANDLER
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id; const userId = call.from.id; const data = call.data;
    bot.answerCallbackQuery(call.id);

    // AI MENU & AI BALANCES
    if (data === 'ai_menu') return showAIMenu(chatId, call.message.message_id);
    if (data === 'ai_toggle') { const s = await getAISettings(); await setSetting('ai_players_enabled', String(!s.enabled)); return showAIMenu(chatId, call.message.message_id); }
    if (data === 'ai_set_cards') { adminStates[chatId] = 'awaiting_ai_cards'; return bot.sendMessage(chatId, '🃏 Send a number between 1 and 10:'); }
    if (data === 'ai_set_max') { adminStates[chatId] = 'awaiting_ai_max'; return bot.sendMessage(chatId, '👥 Send a number between 1 and 20:'); }
    if (data.startsWith('ai_balances_')) { const page = parseInt(data.split('_')[2] || '0'); return showAIBalances(chatId, page, call.message.message_id); }
    if (data.startsWith('ai_dep_')) {
        const parts = data.split('_'); const aiUserId = parts[2]; const amount = parseInt(parts[3]); const currentPage = parseInt(parts[4] || '0');
        const ok = await depositToAI(aiUserId, amount);
        if (ok) await bot.answerCallbackQuery(call.id, { text: `✅ Added ${amount} ETB` }); else await bot.answerCallbackQuery(call.id, { text: `❌ Failed` });
        return showAIBalances(chatId, currentPage, call.message.message_id);
    }

    // ADMIN PLAYER PAGINATION
    if (data.startsWith('admin_players_')) { const page = parseInt(data.split('_')[2] || '0'); return showAdminPlayers(chatId, page, call.message.message_id); }

    // APPROVALS
    if (data.startsWith('deposit_approve_')) { try { await axios.post(`${API_URL}/api/admin/deposits/approve`, { depositId: data.split('_')[2], adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID }); await bot.sendMessage(chatId, `✅ Approved.`); } catch (e) { await bot.sendMessage(chatId, `❌ Error.`); } return; }
    if (data.startsWith('deposit_reject_')) { try { await axios.post(`${API_URL}/api/admin/deposits/reject`, { depositId: data.split('_')[2], adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID, reason: 'Rejected' }); await bot.sendMessage(chatId, `❌ Rejected.`); } catch (e) { await bot.sendMessage(chatId, `❌ Error.`); } return; }
    if (data.startsWith('withdraw_approve_')) { try { await axios.post(`${API_URL}/api/admin/withdrawals/approve`, { withdrawalId: data.split('_')[2], adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID }); await bot.sendMessage(chatId, `✅ Approved.`); } catch (e) { await bot.sendMessage(chatId, `❌ Error.`); } return; }
    if (data.startsWith('withdraw_reject_')) { try { await axios.post(`${API_URL}/api/admin/withdrawals/reject`, { withdrawalId: data.split('_')[2], adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID, reason: 'Rejected' }); await bot.sendMessage(chatId, `❌ Rejected.`); } catch (e) { await bot.sendMessage(chatId, `❌ Error.`); } return; }

    const fakeMsg = { chat: { id: chatId }, from: { id: userId, first_name: call.from.first_name, last_name: call.from.last_name, username: call.from.username }, text: '/' };

    switch (data) {
        case 'play':     await handlePlay(fakeMsg); break;
        case 'balance':  await handleBalance(fakeMsg); break;
        case 'deposit':  await handleDeposit(fakeMsg); break;
        case 'withdraw': await handleWithdraw(fakeMsg); break;
        case 'transfer': await handleTransfer(fakeMsg); break;
        case 'bonus':    await handleBonus(fakeMsg); break;
        case 'history':  await handleHistory(fakeMsg); break;
        case 'help':     await handleHelp(fakeMsg); break;
        case 'profile':  await handleProfile(fakeMsg); break;
        case 'support':  await bot.sendMessage(chatId, '📞 <b>Support</b>\n@frezerabiy', { parse_mode: 'HTML' }); break;
        case 'patterns': await bot.sendMessage(chatId, `🏆 <b>Patterns</b>\nRow, Column, Diagonal, Corners, Full House.`, { parse_mode: 'HTML' }); break;
        case 'copy_invite': await bot.sendMessage(chatId, `📋 <b>Link:</b>\nhttps://t.me/M_bingo_bot?start=ref_${userId}`, { parse_mode: 'HTML' }); break;
        case 'back_to_menu': await bot.sendMessage(chatId, '🎯 <b>Menu</b>', { parse_mode: 'HTML', ...mainMenu(userId) }); break;
        case 'cancel': await bot.sendMessage(chatId, '❌ Cancelled.'); break;

        case 'admin_panel':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return;
            await bot.sendMessage(chatId, '👑 <b>Admin Panel</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
                [{ text: '👥 Players', callback_data: 'admin_players_0' }], [{ text: '📊 Stats', callback_data: 'admin_stats' }], [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }], [{ text: '📥 Deposits', callback_data: 'admin_deposits' }], [{ text: '📤 Withdrawals', callback_data: 'admin_withdrawals' }],
                [{ text: '🤖 AI Management', callback_data: 'ai_menu' }], [{ text: '🧠 AI Status', callback_data: 'ai_status_cb' }], [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
            ] } });
            break;

        case 'admin_deposits':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return;
            try {
                const res = await axios.get(`${API_URL}/api/admin/deposits?adminId=${ADMIN_DB_ID || ADMIN_TELEGRAM_ID}`);
                if (!res.data.length) return bot.sendMessage(chatId, '📭 No pending deposits.');
                for (const d of res.data) await bot.sendMessage(chatId, `📥 <b>Deposit</b>\n👤 ${escapeHtml(d.userName)}\n💰 ${formatCurrency(d.amount)}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `deposit_approve_${d.id}` }, { text: '❌ Reject',  callback_data: `deposit_reject_${d.id}` }]] } });
            } catch (e) { bot.sendMessage(chatId, '⚠️ Error.'); }
            break;

        case 'admin_withdrawals':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return;
            try {
                const res = await axios.get(`${API_URL}/api/admin/withdrawals?adminId=${ADMIN_DB_ID || ADMIN_TELEGRAM_ID}`);
                if (!res.data.length) return bot.sendMessage(chatId, '📭 No pending withdrawals.');
                for (const w of res.data) await bot.sendMessage(chatId, `📤 <b>Withdrawal</b>\n👤 ${escapeHtml(w.userName)}\n💰 ${formatCurrency(w.amount)}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `withdraw_approve_${w.id}` }, { text: '❌ Reject',  callback_data: `withdraw_reject_${w.id}` }]] } });
            } catch (e) { bot.sendMessage(chatId, '⚠️ Error.'); }
            break;

        case 'admin_stats':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return;
            try {
                const res = await axios.get(`${API_URL}/api/admin/stats?adminId=${ADMIN_DB_ID || ADMIN_TELEGRAM_ID}`);
                const s = res.data;
                await bot.sendMessage(chatId, `📊 <b>Stats</b>\n\n👥 Online: ${s.onlinePlayers || 0}\n🎮 Active Games: ${s.activeGames || 0}\n💰 Revenue: ${s.todayRevenue || 0} ETB\n📈 Users: ${s.totalPlayers || 0}\n🤖 AI: ${s.totalAIPlayers || 0}`, { parse_mode: 'HTML' });
            } catch (e) { bot.sendMessage(chatId, '⚠️ Error.'); }
            break;

        case 'admin_add_balance': await bot.sendMessage(chatId, '💰 Use: /addbalance [telegram_id] [amount]'); break;
        case 'admin_broadcast': await bot.sendMessage(chatId, '📢 Use: /ai_broadcast [message]'); break;
        case 'ai_status_cb': await handleAICommand({ text: '/ai_status', chat: { id: chatId }, from: { id: userId } }); break;
    }
});

// ============================================================
// AI COMMANDS
// ============================================================
async function handleAICommand(msg) {
    const text = (msg.text || '').trim(); const chatId = msg.chat.id;
    if (String(msg.from.id) !== String(ADMIN_TELEGRAM_ID)) return;

    if (text === '/ai_status') {
        const d = await getPendingDeposits(); const w = await getPendingWithdrawals(); const net = await getNetPosition(); const paused = await getSetting('withdrawals_paused'); const running = await getSetting('invite_all_running'); const ai = await getAISettings();
        await bot.sendMessage(chatId, `🤖 <b>AI Agent</b>\n\n📥 Pending deposits: ${d.length}\n📤 Pending withdrawals: ${w.length}\n💼 Net: ${net.toLocaleString()} ETB\n⏸ Paused: ${paused === 'true' ? 'YES' : 'no'}\n🔄 Invite-all: ${running === 'true' ? 'RUNNING' : 'stopped'}\n🎭 AI players: ${ai.enabled ? 'ENABLED' : 'disabled'} (${ai.cards} cards, max ${ai.maxPerRoom})`, { parse_mode: 'HTML' });
    }
    else if (text === '/ai_report') { await sendDailyReport(); await bot.sendMessage(chatId, '✅ Sent.'); }
    else if (text === '/ai_pause')  { await setSetting('withdrawals_paused', 'true');  await bot.sendMessage(chatId, '⏸ Paused.'); }
    else if (text === '/ai_resume') { await setSetting('withdrawals_paused', 'false'); await bot.sendMessage(chatId, '▶ Resumed.'); }
    else if (text.startsWith('/ai_set_threshold ')) { const v = Number(text.slice(17).trim()); if (!Number.isFinite(v) || v < 0) await bot.sendMessage(chatId, '❌ Invalid.'); else { await setSetting('pause_threshold', String(v)); await bot.sendMessage(chatId, `✅ ${v} ETB`); } }
    else if (text === '/ai_run_deposits') { const deposits = await getPendingDeposits(); if (!deposits.length) return bot.sendMessage(chatId, '📭 None pending.'); for (const d of deposits) await notifyAdminAboutDeposit(d); await bot.sendMessage(chatId, `📨 Sent ${deposits.length}.`); }
    else if (text === '/ai_run_withdrawals') {
        const wds = await getPendingWithdrawals(); let a = 0, r = 0, v = 0;
        for (const w of wds) { const an = await analyzeWithdrawal(w); if (an.decision === 'reject') { await rejectWithdrawalAI(w.id, 'AI'); r++; } else if (an.decision === 'approve' && AUTO_APPROVE_WITHDRAWAL_MAX > 0 && Number(w.amount) <= AUTO_APPROVE_WITHDRAWAL_MAX) { await approveWithdrawalAI(w.id, 'AI'); a++; } else { v++; await bot.sendMessage(chatId, `⚠️ ${w.userName} / ${w.amount} ETB`); } }
        await bot.sendMessage(chatId, `✅ A:${a} R:${r} V:${v}`);
    }
    else if (text === '/ai_promo') { await postPromotion(); await bot.sendMessage(chatId, '✅ Posted.'); }
    else if (text === '/ai_broadcast' || text.startsWith('/ai_broadcast ')) {
        const messageText = text.slice('/ai_broadcast'.length).trim();
        if (messageText) { adminStates[chatId] = 'awaiting_broadcast_confirmation'; await prepareBroadcast(msg, 'all', messageText); }
        else { adminStates[chatId] = 'awaiting_broadcast_content'; await bot.sendMessage(chatId, '📢 Send your message or photo. /cancel to stop.'); }
    }
    else if (text === '/ai_wakeup') { await keepAlive(); await bot.sendMessage(chatId, '✅ Pinged.'); }
    else if (text === '/ai_invite') { await bot.sendMessage(chatId, '📨 Inviting...'); const r = await inviteUsersToGroup(INVITE_BATCH_SIZE); await bot.sendMessage(chatId, `✅ I:${r.invited} F:${r.failed}`); }
    else if (text === '/ai_invite_all') { await setSetting('invite_all_running', 'true'); await bot.sendMessage(chatId, `▶️ Started.`); setTimeout(runInviteAllBatch, 2000); }
    else if (text === '/ai_invite_stop') { await setSetting('invite_all_running', 'false'); await bot.sendMessage(chatId, '🛑 Stopped.'); }
    else { await bot.sendMessage(chatId, '❓ Unknown /ai_ command.'); }
}
bot.onText(/^\/ai_/, handleAICommand);

// ============================================================
// TEXT STATE HANDLER
// ============================================================
bot.on('text', async (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id; const text = (msg.text || '').trim();
    if (String(userId) !== String(ADMIN_TELEGRAM_ID)) return;
    if (!adminStates[chatId]) return;
    if (text.startsWith('/')) { if (text === '/cancel') { delete adminStates[chatId]; await bot.sendMessage(chatId, '❌ Cancelled.'); } return; }

    const state = adminStates[chatId];
    if (state === 'awaiting_broadcast_content') { await prepareBroadcast(msg, 'all', text); return; }
    if (state === 'awaiting_ai_cards') { const cards = parseInt(text); if (isNaN(cards) || cards < 1 || cards > 10) return bot.sendMessage(chatId, '❌ Invalid (1-10).'); await setSetting('ai_cards_per_game', String(cards)); delete adminStates[chatId]; await bot.sendMessage(chatId, `✅ Cards set to ${cards}.`); await showAIMenu(chatId); return; }
    if (state === 'awaiting_ai_max') { const max = parseInt(text); if (isNaN(max) || max < 1 || max > 20) return bot.sendMessage(chatId, '❌ Invalid (1-20).'); await setSetting('max_ai_players_per_room', String(max)); delete adminStates[chatId]; await bot.sendMessage(chatId, `✅ Max set to ${max}.`); await showAIMenu(chatId); return; }
    delete adminStates[chatId];
});

// ============================================================
// BROADCAST HELPERS
// ============================================================
const broadcastDrafts = new Map();
const BROADCAST_DELAY_MS = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prepareBroadcast(msg, audience = 'all', suppliedText = '') {
    const chatId = msg.chat.id;
    const payload = { chatId, sourceMessageId: msg.message_id || null, text: suppliedText || msg.text || msg.caption || '', type: msg.photo ? 'photo' : (msg.video ? 'video' : 'text'), audience };
    if (payload.type === 'text' && !payload.text.trim()) return bot.sendMessage(chatId, '❌ Empty text.');
    broadcastDrafts.set(String(chatId), payload); adminStates[chatId] = 'awaiting_broadcast_confirmation';
    await bot.sendMessage(chatId, `📢 <b>Preview:</b> ${payload.type}\n\n${escapeHtml(payload.text.slice(0, 500))}\n\nSend?`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: 'broadcast_confirm' }, { text: '❌ Cancel', callback_data: 'broadcast_cancel' }]] } });
}

async function executeBroadcast(chatId) {
    const draft = broadcastDrafts.get(String(chatId)); if (!draft) return bot.sendMessage(chatId, '❌ No draft.');
    const result = await pool.query(`SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL`);
    const ids = [...new Set(result.rows.map(r => String(r.telegram_id)).filter(Boolean))];
    let sent = 0, failed = 0;
    await bot.sendMessage(chatId, `⏳ Sending to ${ids.length} users...`);
    for (const targetId of ids) { try { if (draft.type === 'photo') await bot.copyMessage(targetId, draft.chatId, draft.sourceMessageId); else await bot.sendMessage(targetId, draft.text); sent++; } catch (e) { failed++; } await sleep(BROADCAST_DELAY_MS); }
    broadcastDrafts.delete(String(chatId)); delete adminStates[chatId];
    await bot.sendMessage(chatId, `✅ Finished. Sent: ${sent}, Failed: ${failed}`);
}

bot.on('callback_query', async (call) => {
    if (call.data === 'broadcast_confirm') { await executeBroadcast(call.message.chat.id); }
    if (call.data === 'broadcast_cancel') { broadcastDrafts.delete(String(call.message.chat.id)); delete adminStates[call.message.chat.id]; await bot.sendMessage(call.message.chat.id, '🛑 Cancelled.'); }
});

// ============================================================
// CRON & POLLER & STARTUP
// ============================================================
setInterval(async () => {
    try {
        const deposits = await pool.query(`SELECT d.*, u.telegram_id FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status IN ('APPROVED','REJECTED') AND d.notified = FALSE`);
        for (const d of deposits.rows) { try { await bot.sendMessage(d.telegram_id, d.status === 'APPROVED' ? `💰 Deposit of ${formatCurrency(d.amount)} added!` : `❌ Deposit rejected.`); } catch (e) {} await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]); }
        const withdrawals = await pool.query(`SELECT w.*, u.telegram_id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status IN ('APPROVED','REJECTED') AND w.notified = FALSE`);
        for (const w of withdrawals.rows) { try { await bot.sendMessage(w.telegram_id, w.status === 'APPROVED' ? `🏦 Withdrawal of ${formatCurrency(w.amount)} approved!` : `❌ Withdrawal rejected.`); } catch (e) {} await pool.query('UPDATE withdrawals SET notified = TRUE WHERE id = $1', [w.id]); }
    } catch (e) {}
}, 10000);

function startCronJobs() {
    cron.schedule('*/5 * * * *', keepAlive);
    cron.schedule('0 9,15,21 * * *', postPromotion);
    cron.schedule('*/30 * * * *', checkAndAutoPause);
    cron.schedule('0 23 * * *', sendDailyReport);
}
startCronJobs();

(async () => {
    await initSettingsTable(); await keepAlive(); await inviter.init();
    console.log('✅ AI agent features active');
})();

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Port ${PORT}`));
bot.setChatMenuButton({ menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } } }).catch(() => {});

process.on('unhandledRejection', e => console.error('unhandled:', e?.message || e));
process.on('uncaughtException',  e => console.error('uncaught:',  e?.message || e));
