// ============================================================
// M-BINGO TELEGRAM BOT — MERGED WITH AI AGENT
// Single service · single bot token · single poller
// ============================================================
// Player commands + admin panel (from bot.js)
// PLUS: AI withdrawal review, daily report, auto-pause,
//       promo poster, user inviter / DM (from ai-agent.js)
// PLUS: AI Player Management (enable/disable, cards, balances, deposits)
// PLUS: Phone Number Transfers with 500 Birr limit
// PLUS: AI Contact Inviter & Group Member Inviter
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
console.log(`📡 API URL:         ${API_URL}`);
console.log(`🎮 Game URL:        ${GAME_URL}`);
console.log(`👑 Admin Telegram:  ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port:            ${PORT}`);
console.log(`🧠 AI:              ${OPENAI_API_KEY ? AI_MODEL : 'DISABLED'}`);
console.log(`📣 Promo groups:    ${PROMO_GROUP_IDS.join(', ') || 'none'}`);
console.log(`📨 Invite target:   ${PROMO_TARGET_GROUP || 'not set'}`);

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
// OPTIONAL USER-CLIENT INVITER (MTProto)
// ============================================================
let inviter;
try {
    inviter = require('./telegram-user-inviter');
    console.log('✅ telegram-user-inviter loaded');
} catch (e) {
    console.warn('⚠️ telegram-user-inviter.js not found — invite/DM commands disabled');
    inviter = {
        init:          async () => {},
        isReady:       () => false,
        inviteToGroup: async () => false,
        sendDM:        async () => false,
        sendManyDMs:   async () => ({ sent: 0, failed: 0 }),
        getContacts:   async () => [],
        getGroupMembers: async () => [],
    };
}

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function formatCurrency(amount) {
    return Number(amount || 0).toLocaleString('en-US') + ' ETB';
}
function normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/[^0-9]/g, ''); // Remove all non-digits
    if (cleaned.startsWith('251')) cleaned = '0' + cleaned.slice(3); // 2519... -> 09...
    if (cleaned.length === 9 && !cleaned.startsWith('0')) cleaned = '0' + cleaned; // 9... -> 09...
    return cleaned;
}

// Admin conversation states (for AI text input flows)
const adminStates = {};

// ============================================================
// AI SETTINGS TABLE
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
                ('withdrawals_paused', 'false'),
                ('pause_threshold', $1),
                ('invite_all_running', 'false'),
                ('invite_last_run_at', ''),
                ('ai_players_enabled', 'false'),
                ('ai_cards_per_game', '2'),
                ('max_ai_players_per_room', '5')
            ON CONFLICT (key) DO NOTHING
        `, [String(AUTO_PAUSE_THRESHOLD)]);
        console.log('✅ admin_settings ready');
    } catch (e) { console.error('initSettingsTable:', e.message); }
}

async function getSetting(k) {
    const r = await pool.query(`SELECT value FROM admin_settings WHERE key = $1`, [k]);
    return r.rows[0]?.value;
}
async function setSetting(k, v) {
    await pool.query(`
        INSERT INTO admin_settings (key, value, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
    `, [k, String(v)]);
}

// ============================================================
// AI PLAYER MANAGEMENT HELPERS
// ============================================================
async function getAISettings() {
    try {
        const result = await pool.query(
            `SELECT key, value FROM admin_settings WHERE key IN ('ai_players_enabled', 'ai_cards_per_game', 'max_ai_players_per_room')`
        );
        const settings = { enabled: false, cards: 2, maxPerRoom: 5 };
        result.rows.forEach(row => {
            if (row.key === 'ai_players_enabled') settings.enabled = row.value === 'true';
            if (row.key === 'ai_cards_per_game') settings.cards = Number(row.value);
            if (row.key === 'max_ai_players_per_room') settings.maxPerRoom = Number(row.value);
        });
        return settings;
    } catch (e) {
        console.error('getAISettings:', e.message);
        return { enabled: false, cards: 2, maxPerRoom: 5 };
    }
}

async function updateAISettings(data) {
    try {
        if (data.enabled !== undefined) await setSetting('ai_players_enabled', String(data.enabled));
        if (data.cards !== undefined) await setSetting('ai_cards_per_game', String(data.cards));
        if (data.maxPerRoom !== undefined) await setSetting('max_ai_players_per_room', String(data.maxPerRoom));
        return true;
    } catch (e) {
        console.error('updateAISettings:', e.message);
        return false;
    }
}

async function getAIPlayers() {
    try {
        const result = await pool.query(
            `SELECT id, first_name AS name, balance FROM users WHERE is_ai = TRUE ORDER BY balance DESC`
        );
        return result.rows;
    } catch (e) {
        console.error('getAIPlayers:', e.message);
        return [];
    }
}

async function depositToAI(aiUserId, amount) {
    try {
        const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
        await axios.post(`${API_URL}/api/admin/ai/balance`,
            { aiUserId, amount, adminId },
            { headers: { 'x-admin-id': adminId } }
        );
        return true;
    } catch (e) {
        console.error('depositToAI:', e.message);
        return false;
    }
}

// ---------- AI Menu Renderer ----------
async function showAIMenu(chatId, messageId = null) {
    const settings = await getAISettings();
    const aiPlayers = await getAIPlayers();
    const totalAIBalance = aiPlayers.reduce((s, p) => s + Number(p.balance || 0), 0);

    const text =
        `🤖 <b>AI Player Management</b>\n\n` +
        `Status: ${settings.enabled ? '✅ <b>ENABLED</b>' : '❌ <b>DISABLED</b>'}\n` +
        `🃏 Cards per AI: <b>${settings.cards}</b>\n` +
        `👥 Max AI per room: <b>${settings.maxPerRoom}</b>\n` +
        `🎭 Total AI players: <b>${aiPlayers.length}</b>\n` +
        `💰 Total AI balance: <b>${formatCurrency(totalAIBalance)}</b>\n\n` +
        `Choose an option below:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: settings.enabled ? '🔴 Disable AI' : '🟢 Enable AI', callback_data: 'ai_toggle' }],
            [{ text: '🃏 Set Cards per AI', callback_data: 'ai_set_cards' }],
            [{ text: '👥 Set Max AI per Room', callback_data: 'ai_set_max' }],
            [{ text: '💰 AI Balances & Deposit', callback_data: 'ai_balances' }],
            [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_panel' }]
        ]
    };

    try {
        if (messageId) {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
        }
    } catch (e) { console.error('showAIMenu:', e.message); }
}

// ---------- AI Balances Renderer ----------
async function showAIBalances(chatId, messageId = null) {
    const players = await getAIPlayers();

    if (!players.length) {
        return bot.sendMessage(chatId, '❌ No AI players found. Run the SQL insert script first.');
    }

    let text = `💰 <b>AI Player Balances</b>\n\n`;
    const keyboard = [];

    // Show first 10 AI players
    players.slice(0, 10).forEach((p, index) => {
        text += `${index + 1}. <b>${escapeHtml(p.name)}</b> — ${formatCurrency(p.balance)}\n`;
        const shortId = p.id.substring(0, 8);
        keyboard.push([
            { text: `➕ 500 → ${p.name}`, callback_data: `ai_dep_${p.id}_500` },
            { text: `➕ 1000 → ${p.name}`, callback_data: `ai_dep_${p.id}_1000` }
        ]);
    });

    text += `\n<i>Showing top 10 of ${players.length} AI players</i>`;

    keyboard.push([{ text: '🔙 Back to AI Menu', callback_data: 'ai_menu' }]);

    const options = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

    try {
        if (messageId) {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (e) {
        // If message too long or edit fails, send fresh
        try { await bot.sendMessage(chatId, text, options); } catch (_) {}
    }
}

// ============================================================
// AI HELPERS (OpenAI)
// ============================================================
async function askAI(sys, usr) {
    if (!OPENAI_API_KEY) return null;
    try {
        const r = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user',   content: usr }
                ],
                temperature: 0.7,
                max_tokens: 400
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        return r.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { console.error('AI:', e.message); return null; }
}

async function getPendingDeposits() {
    const r = await pool.query(`
        SELECT d.*, u.first_name AS "userName", u.telegram_id AS "userId", u.balance AS "userBalance"
        FROM deposits d JOIN users u ON u.id = d.user_id
        WHERE d.status = 'PENDING' ORDER BY d.created_at ASC
    `);
    return r.rows;
}
async function getPendingWithdrawals() {
    const r = await pool.query(`
        SELECT w.*, u.first_name AS "userName", u.telegram_id AS "userId", u.balance AS "userBalance"
        FROM withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.status = 'PENDING' ORDER BY w.created_at ASC
    `);
    return r.rows;
}

// ============================================================
// DEPOSIT NOTIFY TO ADMIN
// ============================================================
const askedDeposits = new Set();

async function notifyAdminAboutDeposit(d) {
    if (askedDeposits.has(d.id)) return;
    askedDeposits.add(d.id);

    const msg =
        `📥 <b>New Deposit Request</b>\n\n` +
        `👤 <b>User:</b> ${escapeHtml(d.userName || 'Unknown')}\n` +
        `🆔 <b>Telegram:</b> ${d.userId}\n` +
        `💰 <b>Amount:</b> ${Number(d.amount).toLocaleString()} ETB\n` +
        `🏦 <b>Method:</b> ${escapeHtml(d.method || 'N/A')}\n` +
        `📝 <b>Ref:</b> ${escapeHtml(d.reference || 'N/A')}\n` +
        `💼 <b>Balance before:</b> ${Number(d.userBalance).toLocaleString()} ETB\n\n` +
        `Please approve or reject:`;

    const keyboard = {
        inline_keyboard: [[
            { text: '✅ Approve', callback_data: `deposit_approve_${d.id}` },
            { text: '❌ Reject',  callback_data: `deposit_reject_${d.id}` }
        ]]
    };

    try {
        await bot.sendMessage(REPORT_TELEGRAM_ID, msg, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        console.log(`📨 Asked admin about deposit ${d.id}`);
    } catch (e) {
        console.error('notifyAdminAboutDeposit:', e.message);
        askedDeposits.delete(d.id);
    }
}

// ============================================================
// WITHDRAWAL APPROVE / REJECT (used by AI review path)
// ============================================================
async function approveWithdrawalAI(id, reason = 'Approved') {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const wr = await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [id]);
        if (!wr.rows.length) { await c.query('ROLLBACK'); return false; }
        const w = wr.rows[0];
        const u = await c.query(`SELECT balance FROM users WHERE id=$1 FOR UPDATE`, [w.user_id]);
        const before = Number(u.rows[0].balance);
        if (before < Number(w.amount)) { await c.query('ROLLBACK'); return false; }
        const after = before - Number(w.amount);
        await c.query(
            `UPDATE users SET balance=$1, withdrawal_reserved=GREATEST(0, COALESCE(withdrawal_reserved,0)-$2) WHERE id=$3`,
            [after, Number(w.amount), w.user_id]
        );
        await c.query(
            `INSERT INTO wallet_transactions
              (user_id,type,amount,balance_before,balance_after,reference_type,reference_id)
             VALUES ($1,'WITHDRAWAL',$2,$3,$4,'WITHDRAWAL',$5)`,
            [w.user_id, w.amount, before, after, w.id]
        );
        await c.query(
            `UPDATE withdrawals SET status='APPROVED', approved_at=CURRENT_TIMESTAMP, varify_status=$2 WHERE id=$1`,
            [w.id, reason]
        );
        await c.query('COMMIT');
        return true;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('approveWithdrawalAI:', e.message);
        return false;
    } finally { c.release(); }
}

async function rejectWithdrawalAI(id, reason) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const wr = await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [id]);
        if (!wr.rows.length) { await c.query('ROLLBACK'); return false; }
        const w = wr.rows[0];
        await c.query(
            `UPDATE users SET withdrawal_reserved=GREATEST(0, COALESCE(withdrawal_reserved,0)-$1) WHERE id=$2`,
            [Number(w.amount), w.user_id]
        );
        await c.query(
            `UPDATE withdrawals SET status='REJECTED', rejected_at=CURRENT_TIMESTAMP, rejection_reason=$2 WHERE id=$1`,
            [w.id, reason]
        );
        await c.query('COMMIT');
        return true;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('rejectWithdrawalAI:', e.message);
        return false;
    } finally { c.release(); }
}

// ============================================================
// AI WITHDRAWAL ANALYSIS
// ============================================================
async function analyzeWithdrawal(w) {
    const sys = `You are a fraud-detection assistant for an Ethiopian bingo app.
Respond ONLY with JSON: {"decision":"approve"|"reject"|"review","reason":"short reason"}.`;
    const usr =
        `Withdrawal:\n` +
        `- User: ${w.userName} (${w.userId})\n` +
        `- Amount: ${w.amount} ETB\n` +
        `- Method: ${w.method}\n` +
        `- Destination: ${w.destination}\n` +
        `- Balance: ${w.userBalance} ETB`;
    const raw = await askAI(sys, usr);
    if (!raw) return { decision: 'review', reason: 'AI unavailable' };
    try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return { decision: 'review', reason: 'parse failed' }; }
}

// ============================================================
// PROMO POSTING
// ============================================================
async function generatePromoMessage() {
    const sys = `Write a short exciting Amharic promo for an Ethiopian bingo app. Emojis. Max 3 sentences.`;
    const usr = `Mention: 10 Birr stake, real ETB prizes, 50 Birr bonus for new users. Link: ${GAME_URL}`;
    const m = await askAI(sys, usr);
    return m || `🎯 ቢንጎ ጨዋታ!\n\n💥 10 ብር ብቻ!\n🎁 50 ብር ቦነስ ለአዲስ ተጫዋቾች!\n👉 ${GAME_URL}`;
}
async function postPromotion() {
    if (!PROMO_GROUP_IDS.length) return;
    const msg = await generatePromoMessage();
    for (const g of PROMO_GROUP_IDS) {
        try {
            await bot.sendMessage(g, msg, { parse_mode: 'Markdown' });
            console.log(`📣 Posted to ${g}`);
        } catch (e) { console.error(`Post ${g}:`, e.message); }
    }
}

// ============================================================
// DAILY REPORT
// ============================================================
async function getDailyStats() {
    const q = async (sql) => (await pool.query(sql)).rows[0];
    const s = {};
    s.depositsTotal      = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM deposits WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.depositsCount      = Number((await q(`SELECT COUNT(*) AS x FROM deposits WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.withdrawalsTotal   = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM withdrawals WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.withdrawalsCount   = Number((await q(`SELECT COUNT(*) AS x FROM withdrawals WHERE status='APPROVED' AND approved_at::date=CURRENT_DATE`)).x);
    s.commissionTotal    = Number((await q(`SELECT COALESCE(SUM(commission_amount),0) AS x FROM commissions WHERE created_at::date=CURRENT_DATE`)).x);
    s.gamesPlayed        = Number((await q(`SELECT COUNT(*) AS x FROM commissions WHERE created_at::date=CURRENT_DATE`)).x);
    s.gamePayouts        = Number((await q(`SELECT COALESCE(SUM(amount),0) AS x FROM wallet_transactions WHERE type='GAME_WIN' AND created_at::date=CURRENT_DATE`)).x);
    s.newUsers           = Number((await q(`SELECT COUNT(*) AS x FROM users WHERE created_at::date=CURRENT_DATE`)).x);
    s.totalUsers         = Number((await q(`SELECT COUNT(*) AS x FROM users`)).x);
    s.activeUsers        = Number((await q(`SELECT COUNT(DISTINCT user_id) AS x FROM wallet_transactions WHERE created_at::date=CURRENT_DATE`)).x);
    s.pendingDeposits    = Number((await q(`SELECT COUNT(*) AS x FROM deposits WHERE status='PENDING'`)).x);
    s.pendingWithdrawals = Number((await q(`SELECT COUNT(*) AS x FROM withdrawals WHERE status='PENDING'`)).x);
    s.netToday = s.depositsTotal - s.withdrawalsTotal + s.commissionTotal - s.gamePayouts;
    return s;
}
async function getNetPosition() {
    const r = await pool.query(`
        SELECT
          COALESCE((SELECT SUM(amount) FROM deposits    WHERE status='APPROVED'),0)
        - COALESCE((SELECT SUM(amount) FROM withdrawals WHERE status='APPROVED'),0) AS net
    `);
    return Number(r.rows[0].net);
}
async function sendDailyReport() {
    try {
        const s = await getDailyStats();
        const net = await getNetPosition();
        const paused = (await getSetting('withdrawals_paused')) === 'true';
        const msg = `📊 <b>M-BINGO DAILY REPORT</b> — ${new Date().toLocaleDateString('en-GB')}

💰 Deposits: ${s.depositsTotal.toLocaleString()} ETB (${s.depositsCount})
📤 Withdrawals: ${s.withdrawalsTotal.toLocaleString()} ETB (${s.withdrawalsCount})
🏆 Game payouts: ${s.gamePayouts.toLocaleString()} ETB
💵 Commission: ${s.commissionTotal.toLocaleString()} ETB
🎮 Games: ${s.gamesPlayed}

👥 New users: ${s.newUsers}
🔥 Active: ${s.activeUsers}
📈 Total: ${s.totalUsers}

📉 Net today: ${s.netToday >= 0 ? '+' : ''}${s.netToday.toLocaleString()} ETB
💼 Net all-time: ${net.toLocaleString()} ETB
🚨 Withdrawals: ${paused ? '⏸ PAUSED' : '▶ Active'}

⏳ Pending deposits: ${s.pendingDeposits}
⏳ Pending withdrawals: ${s.pendingWithdrawals}`;
        await bot.sendMessage(REPORT_TELEGRAM_ID, msg, { parse_mode: 'HTML' });
    } catch (e) { console.error('sendDailyReport:', e.message); }
}

// ============================================================
// AUTO-PAUSE
// ============================================================
async function checkAndAutoPause() {
    try {
        const net = await getNetPosition();
        const threshold = Number(await getSetting('pause_threshold') || AUTO_PAUSE_THRESHOLD);
        const paused = (await getSetting('withdrawals_paused')) === 'true';
        if (net < threshold && !paused) {
            await setSetting('withdrawals_paused', 'true');
            await bot.sendMessage(REPORT_TELEGRAM_ID,
                `🚨 <b>AUTO-PAUSE</b>\nNet ${net.toLocaleString()} ETB < ${threshold.toLocaleString()} ETB\n⏸ Withdrawals PAUSED.`,
                { parse_mode: 'HTML' });
        } else if (net >= threshold && paused) {
            await setSetting('withdrawals_paused', 'false');
            await bot.sendMessage(REPORT_TELEGRAM_ID,
                `✅ <b>AUTO-RESUME</b>\nNet ${net.toLocaleString()} ETB\n▶ Withdrawals ACTIVE.`,
                { parse_mode: 'HTML' });
        }
    } catch (e) { console.error('checkAndAutoPause:', e.message); }
}

// ============================================================
// KEEP-ALIVE PING
// ============================================================
async function keepAlive() {
    const targets = [
        { name: 'Backend', url: `${API_URL}/health` },
        { name: 'Self',    url: `${SELF_URL}/health` }
    ];
    for (const t of targets) {
        try {
            const r = await axios.get(t.url, { timeout: 20000 });
            console.log(`✅ ${t.name}: ${r.status}`);
        } catch (e) { console.error(`❌ ${t.name}: ${e.message}`); }
    }
}

// ============================================================
// INVITE / DM
// ============================================================
async function inviteUsersToGroup(limit = INVITE_BATCH_SIZE) {
    if (!PROMO_TARGET_GROUP) return { invited: 0, failed: 0, reason: 'no target group' };
    if (!inviter.isReady()) await inviter.init();
    if (!inviter.isReady()) return { invited: 0, failed: 0, reason: 'user client offline' };

    const r = await pool.query(`
        SELECT telegram_id FROM users
        WHERE telegram_id IS NOT NULL
          AND status = 'ACTIVE'
          AND (last_invited_at IS NULL OR last_invited_at < CURRENT_DATE - INTERVAL '30 days')
        ORDER BY created_at DESC
        LIMIT $1
    `, [limit]);

    let invited = 0, failed = 0;
    for (const u of r.rows) {
        const ok = await inviter.inviteToGroup(PROMO_TARGET_GROUP, u.telegram_id);
        if (ok) {
            invited++;
            await pool.query(`UPDATE users SET last_invited_at=CURRENT_TIMESTAMP WHERE telegram_id=$1`, [u.telegram_id]);
        } else failed++;
        await new Promise(rs => setTimeout(rs, INVITE_DELAY_MS));
    }
    console.log(`📨 Invited=${invited}, Failed=${failed}, total=${r.rows.length}`);
    return { invited, failed, total: r.rows.length };
}

let inviteAllRunning = false;
async function runInviteAllBatch() {
    if (inviteAllRunning) return;
    if ((await getSetting('invite_all_running')) !== 'true') return;

    inviteAllRunning = true;
    try {
        const remaining = await pool.query(`
            SELECT COUNT(*)::int AS n FROM users
            WHERE telegram_id IS NOT NULL AND status='ACTIVE'
              AND (last_invited_at IS NULL OR last_invited_at < CURRENT_DATE - INTERVAL '30 days')
        `);
        const remainingCount = remaining.rows[0].n;
        if (remainingCount === 0) {
            await setSetting('invite_all_running', 'false');
            await bot.sendMessage(REPORT_TELEGRAM_ID,
                `✅ <b>Invite-all complete!</b>\nAll active users have been invited.`,
                { parse_mode: 'HTML' });
            return;
        }
        const res = await inviteUsersToGroup(INVITE_BATCH_SIZE);
        await setSetting('invite_last_run_at', new Date().toISOString());
        await bot.sendMessage(REPORT_TELEGRAM_ID,
            `📨 <b>Invite batch finished</b>\nInvited: ${res.invited}\nFailed: ${res.failed}\nRemaining: ${remainingCount - res.invited}`,
            { parse_mode: 'HTML' });
    } catch (e) {
        console.error('runInviteAllBatch:', e.message);
    } finally { inviteAllRunning = false; }
}

// ============================================================
// ADMIN USER + INTERNAL UUID
// ============================================================
let ADMIN_DB_ID = null;
async function ensureAdminUser() {
    try {
        const result = await pool.query(
            `SELECT id, is_admin FROM users WHERE telegram_id = $1`,
            [ADMIN_TELEGRAM_ID]
        );
        if (result.rows.length === 0) {
            console.log('👑 Admin user not found, creating...');
            await pool.query(
                `INSERT INTO users (telegram_id, username, first_name, balance, is_admin, last_login)
                 VALUES ($1, 'admin', 'Admin', 0, TRUE, CURRENT_TIMESTAMP)`,
                [ADMIN_TELEGRAM_ID]
            );
            console.log('✅ Admin user created');
        } else if (result.rows[0].is_admin !== true) {
            await pool.query(`UPDATE users SET is_admin = TRUE WHERE telegram_id = $1`, [ADMIN_TELEGRAM_ID]);
            console.log('✅ User upgraded to admin');
        } else {
            console.log('✅ Admin user already exists');
        }
        const idResult = await pool.query(
            `SELECT id FROM users WHERE telegram_id = $1 AND is_admin = TRUE`,
            [ADMIN_TELEGRAM_ID]
        );
        if (idResult.rows.length) {
            ADMIN_DB_ID = idResult.rows[0].id;
            console.log(`✅ Admin DB ID: ${ADMIN_DB_ID}`);
        }
    } catch (error) {
        console.error('❌ Failed to ensure admin user:', error.message);
    }
}
ensureAdminUser();

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

app.get('/', (req, res) => res.send('M-BINGO Bot (AI-merged) is running ✅'));
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.json({ status: 'ok', database: 'connected', ai: OPENAI_API_KEY ? 'enabled' : 'disabled' });
    } catch (e) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (ADMIN_PASSWORD_HASH) {
        const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    } else if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    res.json({ success: true, adminId: ADMIN_DB_ID || ADMIN_TELEGRAM_ID });
});

// ============================================================
// TELEGRAM BOT
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
bot.deleteWebHook().catch(() => console.log('Webhook deleted (or not set).'));

// ============================================================
// PLAYER HELPERS
// ============================================================
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode, phoneNumber) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId,
            username: username || `user_${telegramId}`,
            firstName,
            lastName: lastName || '',
            referralCode: referralCode || null,
            phone: phoneNumber // ⭐ Pass the normalized phone number
        }, { headers: { 'X-Bot-Token': BOT_TOKEN } });
        return response.data.user;
    } catch (error) {
        console.error('Registration error:', error.message);
        return null;
    }
}
async function getUserBalance(telegramId) {
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
        return response.data.balance || 0;
    } catch { return 0
