// ============================================================
// M-BINGO TELEGRAM BOT — MERGED WITH AI AGENT
// Single service · single bot token · single poller
// ============================================================
// Player commands + admin panel (from bot.js)
// PLUS: AI withdrawal review, daily report, auto-pause,
//       promo poster, user inviter / DM (from ai-agent.js)
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
// Loads telegram-user-inviter.js if present; otherwise stubs out
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
                ('invite_last_run_at', '')
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
// AI HELPERS
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
// DEPOSIT NOTIFY TO ADMIN (uses same callback_data as bot.js)
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
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId,
            username: username || `user_${telegramId}`,
            firstName,
            lastName: lastName || '',
            referralCode: referralCode || null
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
    } catch { return 0; }
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
// COMMAND HANDLERS (unchanged from original bot.js)
// ============================================================
async function handleStart(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = escapeHtml(msg.from.first_name || 'Player');
    const lastName  = escapeHtml(msg.from.last_name  || '');
    const username  = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) {
            const balance = await getUserBalance(userId);
            const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
            const welcomeBack = `👋 <b>Welcome back, ${firstName}!</b>${isAdmin ? ' 👑' : ''}\n\n` +
                `💰 <b>Balance:</b> ${formatCurrency(balance)}\n` +
                `📊 <b>Games Played:</b> ${response.data.user.gamesPlayed || 0}\n` +
                `🏆 <b>Wins:</b> ${response.data.user.wins || 0}\n\n` +
                `👇 <b>Select an option below:</b>`;
            await bot.sendMessage(chatId, welcomeBack, { parse_mode: 'HTML', ...mainMenu(userId) });
            return;
        }
    } catch (error) {}

    const registerMessage = `
📝 <b>Welcome to M-BINGO, ${firstName}!</b>

To complete your registration, please share your contact by clicking the button below.

🔒 <b>Your Telegram ID will be used to securely identify you.</b>
    `;
    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, registerMessage, { parse_mode: 'HTML', ...registerKeyboard });
    bot._referralMap = bot._referralMap || {};
    bot._referralMap[userId] = referralId;
}

async function handlePlay(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try { await axios.get(`${API_URL}/api/users/${userId}`); }
    catch (e) { await bot.sendMessage(chatId, '❌ Please register first using /start.'); return; }
    const gameUrl = `${GAME_URL}?mode=lobby&userId=${userId}`;
    await bot.sendMessage(chatId, '🎮 <b>Join a game room below:</b>\n\nClick to open the game.', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎮 Open Game", web_app: { url: gameUrl } }],
                [{ text: "🔙 Back", callback_data: 'back_to_menu' }]
            ]
        }
    });
}
async function handleBalance(msg) {
    const balance = await getUserBalance(msg.from.id);
    await bot.sendMessage(msg.chat.id, `💰 <b>Your Balance</b>\n\n${formatCurrency(balance)}`, { parse_mode: 'HTML' });
}
async function handleDeposit(msg) {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🏦 <b>Make a Deposit</b>\n\nPlease enter the amount you wish to deposit (minimum 50 ETB).', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const amount = parseInt(msg2.text);
        if (isNaN(amount) || amount < 50 || amount > 5000) {
            await bot.sendMessage(chatId, '❌ Invalid amount. Please enter a number between 50 and 5000.');
            return;
        }
        await bot.sendMessage(chatId, '💰 <b>Select payment method:</b>', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏦 CBE Bank",  callback_data: `deposit_method_bank_${amount}` }],
                    [{ text: "💳 CBE Birr",  callback_data: `deposit_method_cbe_${amount}` }],
                    [{ text: "📱 E-BIRR",    callback_data: `deposit_method_ebirr_${amount}` }],
                    [{ text: "❌ Cancel",    callback_data: 'cancel' }]
                ]
            }
        });
    });
}
async function handleWithdraw(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await bot.sendMessage(chatId, '📤 <b>Withdrawal</b>\n\nPlease enter the amount you wish to withdraw.', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const amount = parseInt(msg2.text);
        if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
        const balance = await getUserBalance(userId);
        if (amount > balance) {
            await bot.sendMessage(chatId, `❌ Insufficient balance. Your balance is ${formatCurrency(balance)}.`);
            return;
        }
        await bot.sendMessage(chatId, '🏦 <b>Please enter your withdrawal address</b> (Bank Account or Phone Number):', { parse_mode: 'HTML' });
        bot.once('text', async (msg3) => {
            const address = msg3.text.trim();
            if (!address) return;
            try {
                const response = await axios.post(`${API_URL}/api/withdraw/request`, {
                    userId, amount, method: 'cbe_bank', account: address
                });
                if (response.data.success) {
                    await bot.sendMessage(chatId, '⏳ <b>Processing your withdrawal request...</b>\n\nPlease wait for admin approval.', { parse_mode: 'HTML' });
                } else {
                    await bot.sendMessage(chatId, `❌ ${response.data.message || 'Request failed.'}`);
                }
            } catch { await bot.sendMessage(chatId, '❌ Could not connect to server. Please try again.'); }
        });
    });
}
async function handleTransfer(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await bot.sendMessage(chatId, '🔄 <b>Transfer Funds</b>\n\nPlease enter the recipient\'s Telegram ID or username.', { parse_mode: 'HTML' });
    bot.once('text', async (msg2) => {
        const recipientInput = msg2.text.trim();
        let recipientId;
        if (recipientInput.startsWith('@')) {
            try {
                const response = await axios.get(`${API_URL}/api/users/by-username/${recipientInput.substring(1)}`);
                recipientId = response.data.user.telegramId;
            } catch {
                await bot.sendMessage(chatId, '❌ User not found. Please make sure they are registered.');
                return;
            }
        } else {
            recipientId = parseInt(recipientInput);
            if (isNaN(recipientId)) { await bot.sendMessage(chatId, '❌ Invalid input.'); return; }
        }
        try { await axios.get(`${API_URL}/api/users/${recipientId}`); }
        catch {
            await bot.sendMessage(chatId,
                `❌ User with ID ${recipientId} is not registered.\n\n📩 <b>Invite them to join M-BINGO!</b>\nShare this link: https://t.me/M_bingo_bot?start=ref_${userId}`);
            return;
        }
        await bot.sendMessage(chatId, '💵 <b>Enter amount to transfer:</b>', { parse_mode: 'HTML' });
        bot.once('text', async (msg3) => {
            const amount = parseInt(msg3.text);
            if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
            const balance = await getUserBalance(userId);
            if (amount > balance) { await bot.sendMessage(chatId, `❌ Insufficient balance. Your balance is ${formatCurrency(balance)}.`); return; }
            try {
                await axios.post(`${API_URL}/api/transfer`, { fromId: userId, toId: recipientId, amount });
                await bot.sendMessage(chatId, `✅ Successfully transferred ${formatCurrency(amount)} to user ${recipientId}.`);
            } catch { await bot.sendMessage(chatId, '❌ Transfer failed. Please try again later.'); }
        });
    });
}
async function handleBonus(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const inviteLink = `https://t.me/M_bingo_bot?start=ref_${userId}`;
    const inviteMsg = `🎁 <b>Invite Friends & Earn!</b>\n\nShare your unique referral link:\n\n${inviteLink}\n\nFor each friend who registers using your link, you earn <b>${REFERRAL_BONUS} Birr</b>!`;
    await bot.sendMessage(chatId, inviteMsg, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }],
                [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]
            ]
        }
    });
}
async function handleHistory(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/transactions/${userId}`);
        const txs = response.data.transactions || [];
        if (!txs.length) { await bot.sendMessage(chatId, '📜 No transactions found.'); return; }
        let msgText = '📜 <b>Your Transaction History</b>\n\n';
        txs.slice(0, 10).forEach(t => {
            const type = t.type === 'deposit'  ? '💰 Deposit' :
                         t.type === 'withdraw' ? '📤 Withdraw' :
                         t.type === 'transfer' ? '🔄 Transfer' : '🎮 Game';
            const sign = t.type === 'deposit' ? '+' : '-';
            msgText += `${type}: ${sign}${formatCurrency(t.amount)} - ${t.status}\n`;
        });
        await bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
    } catch { await bot.sendMessage(chatId, '⚠️ Could not fetch transactions.'); }
}
async function handleProfile(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        const user = response.data.user;
        const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
        const adminBadge = isAdmin ? ' 👑 (Admin)' : '';
        const message = `
👤 <b>Your Profile</b>${adminBadge}

📛 <b>Name:</b> ${escapeHtml(user.firstName || 'Player')}
🆔 <b>ID:</b> ${user.telegramId}
💰 <b>Balance:</b> ${formatCurrency(user.balance || 0)}
🏆 <b>Games Played:</b> ${user.gamesPlayed || 0}
🎖️ <b>Wins:</b> ${user.wins || 0}
📅 <b>Joined:</b> ${new Date(user.createdAt).toLocaleDateString()}
        `;
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch { await bot.sendMessage(chatId, '⚠️ Could not fetch profile.'); }
}
async function handleHelp(msg) {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `
📖 <b>M-BINGO Help</b>

<b>Commands:</b>
/start - Start bot and register
/play - Start a game
/balance - Check your balance
/deposit - Make a deposit
/withdraw - Withdraw funds
/transfer - Transfer funds
/bonus - Invite friends and earn bonus
/history - Transaction history
/profile - Your profile
/help - This help

<b>Admin AI commands:</b>
/ai_status - Agent status
/ai_report - Send daily report now
/ai_pause - Pause withdrawals
/ai_resume - Resume withdrawals
/ai_set_threshold 1000 - Set auto-pause threshold
/ai_run_deposits - Send pending deposits to admin
/ai_run_withdrawals - Run AI review on pending withdrawals
/ai_promo - Post promo to groups now
/ai_broadcast &lt;msg&gt; - Broadcast to all users
/ai_wakeup - Ping backend + self
/ai_invite [N] - Invite N users to PROMO_TARGET_GROUP
/ai_invite_all - Start continuous invite-all loop
/ai_invite_stop - Stop invite-all
/ai_invite_status - Invite-all status
/ai_dm &lt;id&gt; &lt;msg&gt; - DM one user (from user account)
/ai_dm_all &lt;msg&gt; - DM all active users

<b>How to Play:</b>
1. Tap "Play Game" or use /play
2. Choose your stake
3. Select 1-5 BINGO cards
4. Wait for 2+ players to join
5. First to complete a pattern wins 80% of the pool!

<b>Support:</b> @frezerabiy
    `, { parse_mode: 'HTML' });
}

// Register player commands
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

// ============================================================
// AI ADMIN COMMAND HANDLER
// All commands starting with /ai_ come here (no getUpdates loop)
// ============================================================
async function handleAICommand(msg) {
    const text = (msg.text || '').trim();
    const chatId = msg.chat.id;
    if (String(msg.from.id) !== String(ADMIN_TELEGRAM_ID)) return;

    try {
        if (text === '/ai_status') {
            const d = await getPendingDeposits();
            const w = await getPendingWithdrawals();
            const net = await getNetPosition();
            const paused = await getSetting('withdrawals_paused');
            const running = await getSetting('invite_all_running');
            await bot.sendMessage(chatId,
                `🤖 <b>AI Agent</b>\n\n` +
                `📥 Pending deposits: ${d.length}\n` +
                `📤 Pending withdrawals: ${w.length}\n` +
                `💼 Net: ${net.toLocaleString()} ETB\n` +
                `⏸ Paused: ${paused === 'true' ? 'YES' : 'no'}\n` +
                `📨 User client: ${inviter.isReady() ? 'online' : 'offline'}\n` +
                `🔄 Invite-all: ${running === 'true' ? 'RUNNING' : 'stopped'}`,
                { parse_mode: 'HTML' });
        }

        else if (text === '/ai_report') { await sendDailyReport(); await bot.sendMessage(chatId, '✅ Sent.'); }
        else if (text === '/ai_pause')  { await setSetting('withdrawals_paused', 'true');  await bot.sendMessage(chatId, '⏸ Paused.'); }
        else if (text === '/ai_resume') { await setSetting('withdrawals_paused', 'false'); await bot.sendMessage(chatId, '▶ Resumed.'); }

        else if (text.startsWith('/ai_set_threshold ')) {
            const v = Number(text.slice(17).trim());
            if (!Number.isFinite(v) || v < 0) await bot.sendMessage(chatId, '❌ Invalid.');
            else { await setSetting('pause_threshold', String(v)); await bot.sendMessage(chatId, `✅ ${v} ETB`); }
        }

        else if (text === '/ai_run_deposits') {
            const deposits = await getPendingDeposits();
            if (!deposits.length) { await bot.sendMessage(chatId, '📭 None pending.'); return; }
            for (const d of deposits) await notifyAdminAboutDeposit(d);
            await bot.sendMessage(chatId, `📨 Sent ${deposits.length} to admin.`);
        }

        else if (text === '/ai_run_withdrawals') {
            const wds = await getPendingWithdrawals();
            let a = 0, r = 0, v = 0;
            for (const w of wds) {
                const an = await analyzeWithdrawal(w);
                if (an.decision === 'reject') {
                    await rejectWithdrawalAI(w.id, 'AI: ' + an.reason); r++;
                } else if (an.decision === 'approve'
                           && AUTO_APPROVE_WITHDRAWAL_MAX > 0
                           && Number(w.amount) <= AUTO_APPROVE_WITHDRAWAL_MAX) {
                    await approveWithdrawalAI(w.id, 'AI: ' + an.reason); a++;
                } else {
                    v++;
                    await bot.sendMessage(chatId, `⚠️ ${escapeHtml(w.userName)} / ${w.amount} ETB\n${escapeHtml(an.reason)}`);
                }
            }
            await bot.sendMessage(chatId, `✅ Approved:${a} Rejected:${r} Review:${v}`);
        }

        else if (text === '/ai_promo') { await postPromotion(); await bot.sendMessage(chatId, '✅ Posted.'); }

        else if (text.startsWith('/ai_broadcast ')) {
            const m = text.slice(14).trim();
            const users = await pool.query(`SELECT telegram_id FROM users`);
            let s = 0, f = 0;
            for (const u of users.rows) { try { await bot.sendMessage(u.telegram_id, m); s++; } catch { f++; } }
            await bot.sendMessage(chatId, `📢 Sent:${s} Failed:${f}`);
        }

        else if (text === '/ai_wakeup') { await keepAlive(); await bot.sendMessage(chatId, '✅ Pinged.'); }

        else if (text === '/ai_invite') {
            await bot.sendMessage(chatId, '📨 Inviting...');
            const r = await inviteUsersToGroup(INVITE_BATCH_SIZE);
            await bot.sendMessage(chatId, `✅ Invited:${r.invited} Failed:${r.failed}${r.reason ? ' (' + r.reason + ')' : ''}`);
        }
        else if (text.startsWith('/ai_invite ')) {
            const n = Math.min(Number(text.slice(11).trim()) || INVITE_BATCH_SIZE, 100);
            await bot.sendMessage(chatId, `📨 Inviting up to ${n}...`);
            const r = await inviteUsersToGroup(n);
            await bot.sendMessage(chatId, `✅ Invited:${r.invited} Failed:${r.failed}`);
        }
        else if (text === '/ai_invite_all') {
            await setSetting('invite_all_running', 'true');
            await bot.sendMessage(chatId,
                `▶️ <b>Invite-all started</b>\nThe agent will invite ${INVITE_BATCH_SIZE} users every ~6 hours (${INVITE_RUNS_PER_DAY}×/day).\n\nSend /ai_invite_stop to cancel.`,
                { parse_mode: 'HTML' });
            setTimeout(runInviteAllBatch, 2000);
        }
        else if (text === '/ai_invite_stop') {
            await setSetting('invite_all_running', 'false');
            await bot.sendMessage(chatId, '🛑 Invite-all stopped.');
        }
        else if (text === '/ai_invite_status') {
            const running = (await getSetting('invite_all_running')) === 'true';
            const last = await getSetting('invite_last_run_at');
            const remaining = await pool.query(`
                SELECT COUNT(*)::int AS n FROM users
                WHERE telegram_id IS NOT NULL AND status='ACTIVE'
                  AND (last_invited_at IS NULL OR last_invited_at < CURRENT_DATE - INTERVAL '30 days')
            `);
            await bot.sendMessage(chatId,
                `📨 <b>Invite-all status</b>\nRunning: ${running ? 'YES' : 'no'}\nLast run: ${last || 'never'}\nRemaining: ${remaining.rows[0].n}`,
                { parse_mode: 'HTML' });
        }

        else if (text.startsWith('/ai_dm ')) {
            const rest = text.slice(7).trim();
            const sp = rest.indexOf(' ');
            if (sp < 0) {
                await bot.sendMessage(chatId, '❌ Usage: <code>/ai_dm &lt;telegram_id&gt; &lt;message&gt;</code>', { parse_mode: 'HTML' });
                return;
            }
            const targetId = Number(rest.slice(0, sp));
            const dmMessage = rest.slice(sp + 1).trim();
            if (!Number.isFinite(targetId) || !dmMessage) {
                await bot.sendMessage(chatId, '❌ Invalid telegram_id or empty message.');
                return;
            }
            const ok = await inviter.sendDM(targetId, dmMessage);
            await bot.sendMessage(chatId, ok ? `✅ DM sent to ${targetId}` : `❌ Failed to DM ${targetId}`);
        }
        else if (text.startsWith('/ai_dm_all ')) {
            const dmMessage = text.slice(11).trim();
            if (!dmMessage) { await bot.sendMessage(chatId, '❌ Usage: <code>/ai_dm_all &lt;message&gt;</code>', { parse_mode: 'HTML' }); return; }
            const users = await pool.query(`SELECT telegram_id FROM users WHERE status='ACTIVE'`);
            await bot.sendMessage(chatId, `📨 DMing ${users.rows.length} users from your personal account…`);
            const ids = users.rows.map(r => r.telegram_id);
            const res = await inviter.sendManyDMs(ids, dmMessage, INVITE_DELAY_MS);
            await bot.sendMessage(chatId, `✅ Sent:${res.sent} Failed:${res.failed}`);
        }

        else {
            await bot.sendMessage(chatId, '❓ Unknown /ai_ command. Try /help.');
        }
    } catch (e) {
        console.error('AI cmd:', e.message);
        await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
}

bot.onText(/^\/ai_/, handleAICommand);

// ============================================================
// CONTACT HANDLER (registration)
// ============================================================
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const contact = msg.contact;
    const firstName = escapeHtml(msg.from.first_name || 'Player');
    const lastName  = escapeHtml(msg.from.last_name  || '');
    const username  = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) {
        await bot.sendMessage(chatId, '❌ Please share your own contact.');
        return;
    }

    try {
        const response = await axios.get(`${API_URL}/api/users/${userId}`);
        if (response.data.user) { await bot.sendMessage(chatId, '✅ You are already registered!'); return; }
    } catch {}

    const referralId = bot._referralMap ? bot._referralMap[userId] : null;

    try {
        const user = await getOrCreateUser(userId, firstName, lastName, username, referralId);
        if (user) {
            if (referralId) {
                try {
                    await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId });
                    await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus! Someone registered using your referral link.`);
                } catch {}
            }
            const welcome = `✅ <b>Registration Successful!</b>\n\n🎯 Welcome to M-BINGO, ${firstName}!\n💰 You have received a <b>50 Birr</b> starting balance.\n\n👇 <b>Select an option below to start playing!</b>`;
            await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
            await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML', ...mainMenu(userId) });
            await bot.sendMessage(ADMIN_TELEGRAM_ID,
                `🆕 <b>New User Registered!</b>\n\n👤 Name: ${firstName}\n🆔 ID: ${userId}\n📱 Username: @${username}\n📞 Phone: ${contact.phone_number}`,
                { parse_mode: 'HTML' });
        }
    } catch { await bot.sendMessage(chatId, '❌ Registration failed. Please try again later.'); }
});

// ============================================================
// CALLBACK QUERY HANDLER
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    if (data.startsWith('deposit_method_')) {
        const parts = data.split('_');
        const method = parts[2];
        const amount = parts[3];
        const gameUrl = `${GAME_URL}?mode=deposit&method=${method}&amount=${amount}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ You selected <b>${method.toUpperCase()}</b> for ${amount} Birr.\n\nClick below to complete your deposit.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "💰 Open Deposit Page", web_app: { url: gameUrl } }]] }
        });
        return;
    }

    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        if (stake !== 10) { await bot.sendMessage(chatId, '❌ Invalid stake amount. Only 10 Birr is allowed.'); return; }
        const gameUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\n🎮 Click below to open the game and select your cards:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🎮 Open Game", web_app: { url: gameUrl } }],
                    [{ text: "🔙 Back to Menu", callback_data: 'back_to_menu' }]
                ]
            }
        });
        return;
    }

    // Admin deposit / withdrawal approvals
    if (data.startsWith('deposit_approve_')) {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }
        const depositId = data.split('_')[2];
        try {
            const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
            await axios.post(`${API_URL}/api/admin/deposits/approve`, { depositId, adminId });
            await bot.sendMessage(chatId, `✅ Deposit ${depositId} approved.`);
        } catch (e) {
            await bot.sendMessage(chatId, `❌ Error approving deposit: ${e.response?.data?.error || e.message}`);
        }
        return;
    }
    if (data.startsWith('deposit_reject_')) {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }
        const depositId = data.split('_')[2];
        try {
            const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
            await axios.post(`${API_URL}/api/admin/deposits/reject`, { depositId, adminId, reason: 'Rejected by admin' });
            await bot.sendMessage(chatId, `❌ Deposit ${depositId} rejected.`);
        } catch (e) {
            await bot.sendMessage(chatId, `❌ Error rejecting deposit: ${e.response?.data?.error || e.message}`);
        }
        return;
    }
    if (data.startsWith('withdraw_approve_')) {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }
        const withdrawalId = data.split('_')[2];
        try {
            const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
            await axios.post(`${API_URL}/api/admin/withdrawals/approve`, { withdrawalId, adminId });
            await bot.sendMessage(chatId, `✅ Withdrawal ${withdrawalId} approved.`);
        } catch (e) {
            await bot.sendMessage(chatId, `❌ Error approving withdrawal: ${e.response?.data?.error || e.message}`);
        }
        return;
    }
    if (data.startsWith('withdraw_reject_')) {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }
        const withdrawalId = data.split('_')[2];
        try {
            const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
            await axios.post(`${API_URL}/api/admin/withdrawals/reject`, { withdrawalId, adminId, reason: 'Rejected by admin' });
            await bot.sendMessage(chatId, `❌ Withdrawal ${withdrawalId} rejected.`);
        } catch (e) {
            await bot.sendMessage(chatId, `❌ Error rejecting withdrawal: ${e.response?.data?.error || e.message}`);
        }
        return;
    }

    const fakeMsg = {
        chat: { id: chatId },
        from: { id: userId, first_name: call.from.first_name, last_name: call.from.last_name, username: call.from.username },
        text: '/'
    };

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

        case 'support':
            await bot.sendMessage(chatId, '📞 <b>Contact Support</b>\n\n👤 @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'HTML' });
            break;

        case 'patterns':
            await bot.sendMessage(chatId, `
🏆 <b>Winning Patterns</b>

✅ Row — 5 in a horizontal line
✅ Column — 5 in a vertical line
✅ Diagonal — 5 diagonally
✅ Corners — All 4 corners
✅ Full House — All numbers on card
            `, { parse_mode: 'HTML' });
            break;

        case 'copy_invite': {
            const link = `https://t.me/M_bingo_bot?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 <b>Your Invite Link:</b>\n\n${link}`, { parse_mode: 'HTML' });
            break;
        }

        case 'back_to_menu':
            await bot.sendMessage(chatId, '🎯 <b>Welcome back!</b>', { parse_mode: 'HTML', ...mainMenu(userId) });
            break;

        case 'cancel':
            await bot.sendMessage(chatId, '❌ Action cancelled.');
            break;

        case 'admin_panel': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); break; }
            await bot.sendMessage(chatId, '👑 <b>Admin Panel</b>', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Players',           callback_data: 'admin_players' }],
                        [{ text: '📊 Stats',             callback_data: 'admin_stats' }],
                        [{ text: '💰 Add Balance',       callback_data: 'admin_add_balance' }],
                        [{ text: '📢 Broadcast',         callback_data: 'admin_broadcast' }],
                        [{ text: '📥 Deposit Requests',  callback_data: 'admin_deposits' }],
                        [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
                        [{ text: '🤖 AI Status',         callback_data: 'ai_status_cb' }],
                        [{ text: '🔙 Back',              callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
        }

        case 'ai_status_cb':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await handleAICommand({ text: '/ai_status', chat: { id: chatId }, from: { id: userId } });
            break;

        case 'admin_deposits': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/deposits?adminId=${adminId}`);
                const deposits = response.data;
                if (!deposits || !deposits.length) { await bot.sendMessage(chatId, '📭 No pending deposits.'); break; }
                for (const d of deposits) {
                    const msg = `📥 <b>Deposit Request</b>\n👤 ${escapeHtml(d.userName)} (${d.userId})\n💰 ${formatCurrency(d.amount)}\n📱 ${d.method}\n🆔 ${d.reference}`;
                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Approve', callback_data: `deposit_approve_${d.id}` },
                                { text: '❌ Reject',  callback_data: `deposit_reject_${d.id}` }
                            ]]
                        }
                    });
                }
            } catch (error) { await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`); }
            break;
        }

        case 'admin_withdrawals': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/withdrawals?adminId=${adminId}`);
                const withdrawals = response.data;
                if (!withdrawals || !withdrawals.length) { await bot.sendMessage(chatId, '📭 No pending withdrawals.'); break; }
                for (const w of withdrawals) {
                    const msg = `📤 <b>Withdrawal Request</b>\n👤 ${escapeHtml(w.userName)} (${w.userId})\n💰 ${formatCurrency(w.amount)}\n📱 ${w.method}\n🏦 ${w.destination}`;
                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Approve', callback_data: `withdraw_approve_${w.id}` },
                                { text: '❌ Reject',  callback_data: `withdraw_reject_${w.id}` }
                            ]]
                        }
                    });
                }
            } catch (error) { await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`); }
            break;
        }

        case 'admin_players': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/players?adminId=${adminId}`);
                const players = response.data;
                let msg = '👥 <b>Players List</b>\n\n';
                players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${escapeHtml(p.first_name || 'Player')} — 💰 ${p.balance || 0} Birr\n`);
                msg += `\n📊 Total: ${players.length}`;
                await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            } catch (error) {
                const errMsg = error.response?.data?.error || error.response?.data?.message || error.message;
                await bot.sendMessage(chatId, `⚠️ Error fetching players: ${errMsg}`);
            }
            break;
        }

        case 'admin_stats': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/stats?adminId=${adminId}`);
                const s = response.data;
                await bot.sendMessage(chatId,
                    `📊 <b>Server Stats</b>\n\n👥 Online: ${s.onlinePlayers || 0}\n🎮 Active Games: ${s.activeGames || 0}\n💰 Revenue Today: ${s.todayRevenue || 0} Birr\n📈 Total Users: ${s.totalPlayers || 0}`,
                    { parse_mode: 'HTML' });
            } catch (error) {
                const errMsg = error.response?.data?.error || error.message;
                await bot.sendMessage(chatId, `⚠️ Error fetching stats: ${errMsg}`);
            }
            break;
        }

        case 'admin_add_balance':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '💰 <b>Add Balance</b>\n\nUse: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;

        case 'admin_broadcast':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '📢 <b>Send Broadcast</b>\n\nUse: /ai_broadcast [your message]');
            break;

        default: break;
    }
});

// ============================================================
// LEGACY ADMIN COMMANDS
// ============================================================
bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    const targetId = parseInt(match[1]);
    const amount   = parseInt(match[2]);
    try {
        const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
        await axios.post(`${API_URL}/api/admin/balance/add`, { userId: targetId, amount, adminId });
        await bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch { await bot.sendMessage(chatId, '⚠️ Error adding balance.'); }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    await bot.sendMessage(chatId, `📢 Broadcast sent: "${match[1]}"`);
});

// ============================================================
// NOTIFICATION POLLER (deposit/withdrawal status → user)
// ============================================================
setInterval(async () => {
    try {
        const deposits = await pool.query(
            `SELECT d.*, u.telegram_id FROM deposits d
             JOIN users u ON u.id = d.user_id
             WHERE d.status IN ('APPROVED','REJECTED') AND d.notified = FALSE`
        );
        for (const d of deposits.rows) {
            const msg = d.status === 'APPROVED'
                ? `💰 <b>Deposit Successful!</b> ${formatCurrency(d.amount)} has been added to your balance.`
                : `❌ <b>Deposit Rejected.</b> Please try again or contact support.`;
            try { await bot.sendMessage(d.telegram_id, msg, { parse_mode: 'HTML' }); }
            catch (e) { console.error('Deposit notify:', e.message); }
            await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]);
        }

        const withdrawals = await pool.query(
            `SELECT w.*, u.telegram_id FROM withdrawals w
             JOIN users u ON u.id = w.user_id
             WHERE w.status IN ('APPROVED','REJECTED') AND w.notified = FALSE`
        );
        for (const w of withdrawals.rows) {
            const msg = w.status === 'APPROVED'
                ? `🏦 <b>Withdrawal Successful!</b> ${formatCurrency(w.amount)} is on its way.`
                : `❌ <b>Withdrawal Rejected.</b> Please try again.`;
            try { await bot.sendMessage(w.telegram_id, msg, { parse_mode: 'HTML' }); }
            catch (e) { console.error('Withdrawal notify:', e.message); }
            await pool.query('UPDATE withdrawals SET notified = TRUE WHERE id = $1', [w.id]);
        }
    } catch (e) { console.error('Notification Poller Error:', e.message); }
}, 10000);

// ============================================================
// CRON JOBS (AI agent responsibilities)
// ============================================================
function startCronJobs() {
    cron.schedule('*/5 * * * *', keepAlive);

    // Notify admin about pending deposits every 3 min
    cron.schedule('*/3 * * * *', async () => {
        try {
            const d = await getPendingDeposits();
            for (const x of d) await notifyAdminAboutDeposit(x);
        } catch (e) { console.error('cron dep:', e.message); }
    });

    // AI withdrawal review every 10 min
    cron.schedule('*/10 * * * *', async () => {
        try {
            const wds = await getPendingWithdrawals();
            for (const w of wds) {
                const an = await analyzeWithdrawal(w);
                if (an.decision === 'reject') await rejectWithdrawalAI(w.id, 'AI: ' + an.reason);
            }
        } catch (e) { console.error('cron wd:', e.message); }
    });

    // Promo at 09:00, 15:00, 21:00
    cron.schedule('0 9,15,21 * * *', postPromotion);

    // Auto-pause every 30 min
    cron.schedule('*/30 * * * *', checkAndAutoPause);

    // Daily report at 23:00
    cron.schedule('0 23 * * *', sendDailyReport);

    // Invite-all batches every 6 hours
    cron.schedule('0 */6 * * *', runInviteAllBatch);

    // Daily single invite at 10:00 if invite-all is off
    cron.schedule('0 10 * * *', async () => {
        try {
            const running = (await getSetting('invite_all_running')) === 'true';
            if (!running) await inviteUsersToGroup(INVITE_BATCH_SIZE);
        } catch (e) { console.error('cron invite:', e.message); }
    });

    console.log('✅ AI cron jobs scheduled');
}

// ============================================================
// STARTUP
// ============================================================
(async () => {
    await initSettingsTable();
    await keepAlive();
    await inviter.init();
    startCronJobs();
    setTimeout(checkAndAutoPause, 10000);
    console.log('✅ AI agent features active');
})();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Admin API and health check on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

process.on('unhandledRejection', e => console.error('unhandled:', e?.message || e));
process.on('uncaughtException',  e => console.error('uncaught:',  e?.message || e));

console.log('✅ M-BINGO Bot (merged AI agent) is running!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL:  ${API_URL}`);
console.log(`👑 Admin DB ID: ${ADMIN_DB_ID || 'not yet loaded'}`);
