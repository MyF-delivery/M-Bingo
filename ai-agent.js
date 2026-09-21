// ============================================================
// M-BINGO AI AGENT — v3
// Deposit review + user inviter + DM + batch invite
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const inviter = require('./telegram-user-inviter');

// ============================================================
// CONFIG
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL || 'https://m-bingo-backend.onrender.com';
const SELF_URL = process.env.SELF_URL || 'https://m-bingo-bot.onrender.com';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';

const PROMO_GROUP_IDS = (process.env.PROMO_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REPORT_TELEGRAM_ID = process.env.REPORT_TELEGRAM_ID || ADMIN_TELEGRAM_ID;
const PROMO_TARGET_GROUP = process.env.PROMO_TARGET_GROUP || '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

const AUTO_APPROVE_WITHDRAWAL_MAX = Number(process.env.AUTO_APPROVE_WITHDRAWAL_MAX || 0);
const AUTO_PAUSE_THRESHOLD = Number(process.env.AUTO_PAUSE_THRESHOLD || 1000);

// ⭐ Batch invitation settings
const INVITE_BATCH_SIZE = Number(process.env.INVITE_BATCH_SIZE || 15);   // per run
const INVITE_RUNS_PER_DAY = Number(process.env.INVITE_RUNS_PER_DAY || 4); // times per day
const INVITE_DELAY_MS = Number(process.env.INVITE_DELAY_MS || 2500);      // delay between invites

// ============================================================
// DB
// ============================================================
const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
});

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ============================================================
// LOG
// ============================================================
function log(...a) { console.log(`[${new Date().toISOString()}] [AI-AGENT]`, ...a); }
function logError(...a) { console.error(`[${new Date().toISOString()}] [AI-AGENT][ERROR]`, ...a); }

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
                ('withdrawals_paused', 'false'),
                ('pause_threshold', $1),
                ('invite_all_running', 'false'),
                ('invite_last_run_at', '')
            ON CONFLICT (key) DO NOTHING
        `, [String(AUTO_PAUSE_THRESHOLD)]);
        log('✅ admin_settings ready');
    } catch (e) { logError('initSettingsTable:', e.message); }
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
// KEEP-ALIVE
// ============================================================
async function keepAlive() {
    for (const t of [
        { name: 'Backend', url: `${API_URL}/health` },
        { name: 'Bot', url: `${SELF_URL}/health` },
    ]) {
        try { const r = await axios.get(t.url, { timeout: 20000 }); log(`✅ ${t.name}: ${r.status}`); }
        catch (e) { logError(`❌ ${t.name}: ${e.message}`); }
    }
}

// ============================================================
// AI
// ============================================================
async function askAI(sys, usr) {
    if (!OPENAI_API_KEY) return null;
    try {
        const r = await axios.post('https://api.openai.com/v1/chat/completions',
            { model: AI_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0.7, max_tokens: 400 },
            { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        return r.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { logError('AI:', e.message); return null; }
}

// ============================================================
// PENDING LISTS
// ============================================================
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
// 1. ASK ADMIN FOR DEPOSIT DECISION
// ============================================================
const askedDeposits = new Set();

async function notifyAdminAboutDeposit(d) {
    if (askedDeposits.has(d.id)) return;
    askedDeposits.add(d.id);

    const msg =
        `📥 *New Deposit Request*\n\n` +
        `👤 *User:* ${d.userName || 'Unknown'}\n` +
        `🆔 *Telegram:* ${d.userId}\n` +
        `💰 *Amount:* ${Number(d.amount).toLocaleString()} ETB\n` +
        `🏦 *Method:* ${d.method || 'N/A'}\n` +
        `📝 *Ref:* ${d.reference || 'N/A'}\n` +
        `💼 *Balance before:* ${Number(d.userBalance).toLocaleString()} ETB\n\n` +
        `Please approve or reject:`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ Approve', callback_data: `deposit_approve_${d.id}` },
                { text: '❌ Reject',  callback_data: `deposit_reject_${d.id}` },
            ],
        ],
    };

    try {
        await bot.sendMessage(REPORT_TELEGRAM_ID, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
        log(`📨 Asked admin about deposit ${d.id}`);
    } catch (e) {
        logError('notifyAdminAboutDeposit:', e.message);
        askedDeposits.delete(d.id);
    }
}

// ============================================================
// WITHDRAWAL APPROVE / REJECT
// ============================================================
async function approveWithdrawal(id, reason = 'Approved') {
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
            `INSERT INTO wallet_transactions (user_id,type,amount,balance_before,balance_after,reference_type,reference_id)
             VALUES ($1,'WITHDRAWAL',$2,$3,$4,'WITHDRAWAL',$5)`,
            [w.user_id, w.amount, before, after, w.id]
        );
        await c.query(`UPDATE withdrawals SET status='APPROVED', approved_at=CURRENT_TIMESTAMP, varify_status=$2 WHERE id=$1`,
            [w.id, reason]);
        await c.query('COMMIT');
        return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); logError('approveWithdrawal:', e.message); return false; }
    finally { c.release(); }
}

async function rejectWithdrawal(id, reason) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const wr = await c.query(`SELECT * FROM withdrawals WHERE id=$1 AND status='PENDING' FOR UPDATE`, [id]);
        if (!wr.rows.length) { await c.query('ROLLBACK'); return false; }
        const w = wr.rows[0];
        await c.query(`UPDATE users SET withdrawal_reserved=GREATEST(0, COALESCE(withdrawal_reserved,0)-$1) WHERE id=$2`,
            [Number(w.amount), w.user_id]);
        await c.query(`UPDATE withdrawals SET status='REJECTED', rejected_at=CURRENT_TIMESTAMP, rejection_reason=$2 WHERE id=$1`,
            [w.id, reason]);
        await c.query('COMMIT');
        return true;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); logError('rejectWithdrawal:', e.message); return false; }
    finally { c.release(); }
}

// ============================================================
// AI WITHDRAWAL ANALYSIS
// ============================================================
async function analyzeWithdrawal(w) {
    const sys = `You are a fraud-detection assistant for an Ethiopian bingo app.
Respond ONLY with JSON: {"decision":"approve"|"reject"|"review","reason":"short reason"}.`;
    const usr = `Withdrawal:
- User: ${w.userName} (${w.userId})
- Amount: ${w.amount} ETB
- Method: ${w.method}
- Destination: ${w.destination}
- Balance: ${w.userBalance} ETB`;
    const raw = await askAI(sys, usr);
    if (!raw) return { decision: 'review', reason: 'AI unavailable' };
    try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { return { decision: 'review', reason: 'parse failed' }; }
}

// ============================================================
// PROMO
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
        try { await bot.sendMessage(g, msg, { parse_mode: 'Markdown' }); log(`📣 ${g}`); }
        catch (e) { logError(`Post ${g}:`, e.message); }
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
          COALESCE((SELECT SUM(amount) FROM deposits WHERE status='APPROVED'),0)
        - COALESCE((SELECT SUM(amount) FROM withdrawals WHERE status='APPROVED'),0) AS net
    `);
    return Number(r.rows[0].net);
}

async function sendDailyReport() {
    try {
        const s = await getDailyStats();
        const net = await getNetPosition();
        const paused = (await getSetting('withdrawals_paused')) === 'true';
        const msg = `📊 *M-BINGO DAILY REPORT* — ${new Date().toLocaleDateString('en-GB')}

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
        await bot.sendMessage(REPORT_TELEGRAM_ID, msg, { parse_mode: 'Markdown' });
    } catch (e) { logError('sendDailyReport:', e.message); }
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
                `🚨 *AUTO-PAUSE*\nNet ${net.toLocaleString()} ETB < ${threshold.toLocaleString()} ETB\n⏸ Withdrawals PAUSED.`,
                { parse_mode: 'Markdown' });
        } else if (net >= threshold && paused) {
            await setSetting('withdrawals_paused', 'false');
            await bot.sendMessage(REPORT_TELEGRAM_ID,
                `✅ *AUTO-RESUME*\nNet ${net.toLocaleString()} ETB\n▶ Withdrawals ACTIVE.`,
                { parse_mode: 'Markdown' });
        }
    } catch (e) { logError('checkAndAutoPause:', e.message); }
}

// ============================================================
// INVITE — single batch
// ============================================================
async function inviteUsersToGroup(limit = INVITE_BATCH_SIZE) {
    if (!PROMO_TARGET_GROUP) return { invited: 0, failed: 0, reason: 'no target group' };
    if (!inviter.isReady()) await inviter.init();
    if (!inviter.isReady()) return { invited: 0, failed: 0, reason: 'user client offline' };

    const r = await pool.query(`
        SELECT telegram_id, first_name, username FROM users
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
    log(`📨 Invited=${invited}, Failed=${failed}, total=${r.rows.length}`);
    return { invited, failed, total: r.rows.length };
}

// ============================================================
// ⭐ INVITE ALL — background loop, runs INVITE_RUNS_PER_DAY times
// ============================================================
let inviteAllRunning = false;

async function runInviteAllBatch() {
    if (inviteAllRunning) { log('⏳ invite-all already running'); return; }
    if ((await getSetting('invite_all_running')) !== 'true') { log('🛑 invite-all not enabled'); return; }

    inviteAllRunning = true;
    try {
        // How many users left in this run?
        const remaining = await pool.query(`
            SELECT COUNT(*)::int AS n FROM users
            WHERE telegram_id IS NOT NULL AND status='ACTIVE'
              AND (last_invited_at IS NULL OR last_invited_at < CURRENT_DATE - INTERVAL '30 days')
        `);
        const remainingCount = remaining.rows[0].n;
        log(`🔄 invite-all batch — remaining users: ${remainingCount}`);

        if (remainingCount === 0) {
            await setSetting('invite_all_running', 'false');
            await bot.sendMessage(REPORT_TELEGRAM_ID,
                `✅ *Invite-all complete!*\nAll active users have been invited.`,
                { parse_mode: 'Markdown' });
            return;
        }

        const res = await inviteUsersToGroup(INVITE_BATCH_SIZE);
        await setSetting('invite_last_run_at', new Date().toISOString());

        await bot.sendMessage(REPORT_TELEGRAM_ID,
            `📨 *Invite batch finished*\nInvited: ${res.invited}\nFailed: ${res.failed}\nRemaining: ${remainingCount - res.invited}`,
            { parse_mode: 'Markdown' });
    } catch (e) {
        logError('runInviteAllBatch:', e.message);
    } finally {
        inviteAllRunning = false;
    }
}

// ============================================================
// ADMIN COMMANDS
// ============================================================
async function handleAdminCommand(msg) {
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
                `🤖 *AI Agent*\n\n📥 Pending deposits: ${d.length}\n📤 Pending withdrawals: ${w.length}\n💼 Net: ${net.toLocaleString()} ETB\n⏸ Paused: ${paused === 'true' ? 'YES' : 'no'}\n📨 User client: ${inviter.isReady() ? 'online' : 'offline'}\n🔄 Invite-all: ${running === 'true' ? 'RUNNING' : 'stopped'}`,
                { parse_mode: 'Markdown' });
        }

        else if (text === '/ai_report') { await sendDailyReport(); await bot.sendMessage(chatId, '✅ Sent.'); }
        else if (text === '/ai_pause')  { await setSetting('withdrawals_paused', 'true'); await bot.sendMessage(chatId, '⏸ Paused.'); }
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
                if (an.decision === 'reject') { await rejectWithdrawal(w.id, 'AI: ' + an.reason); r++; }
                else if (an.decision === 'approve' && AUTO_APPROVE_WITHDRAWAL_MAX > 0 && Number(w.amount) <= AUTO_APPROVE_WITHDRAWAL_MAX) {
                    await approveWithdrawal(w.id, 'AI: ' + an.reason); a++;
                } else {
                    v++;
                    await bot.sendMessage(chatId, `⚠️ ${w.userName} / ${w.amount} ETB\n${an.reason}`);
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

        // ---- Single batch invite ----
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

        // ⭐ NEW: Start invite-all (runs 4× per day automatically)
        else if (text === '/ai_invite_all') {
            await setSetting('invite_all_running', 'true');
            await bot.sendMessage(chatId,
                `▶️ *Invite-all started*\nThe agent will invite ${INVITE_BATCH_SIZE} users every ~6 hours automatically (${INVITE_RUNS_PER_DAY}×/day).\n\nSend /ai_invite_stop to cancel.`,
                { parse_mode: 'Markdown' });
            // Kick off the first batch immediately
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
                `📨 *Invite-all status*\nRunning: ${running ? 'YES' : 'no'}\nLast run: ${last || 'never'}\nRemaining: ${remaining.rows[0].n}`,
                { parse_mode: 'Markdown' });
        }

        // ⭐ NEW: DM one user (from your personal account)
        else if (text.startsWith('/ai_dm ')) {
            // Format: /ai_dm <telegram_id> <message>
            const rest = text.slice(7).trim();
            const sp = rest.indexOf(' ');
            if (sp < 0) {
                await bot.sendMessage(chatId, '❌ Usage: `/ai_dm <telegram_id> <message>`', { parse_mode: 'Markdown' });
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

        // ⭐ NEW: DM all users
        else if (text.startsWith('/ai_dm_all ')) {
            const dmMessage = text.slice(11).trim();
            if (!dmMessage) { await bot.sendMessage(chatId, '❌ Usage: `/ai_dm_all <message>`', { parse_mode: 'Markdown' }); return; }
            const users = await pool.query(`SELECT telegram_id FROM users WHERE status='ACTIVE'`);
            await bot.sendMessage(chatId, `📨 DMing ${users.rows.length} users from your personal account…`);
            const ids = users.rows.map(r => r.telegram_id);
            const res = await inviter.sendManyDMs(ids, dmMessage, INVITE_DELAY_MS);
            await bot.sendMessage(chatId, `✅ Sent:${res.sent} Failed:${res.failed}`);
        }
    } catch (e) {
        logError('Admin cmd:', e.message);
        await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
}

// ============================================================
// CRON
// ============================================================
cron.schedule('*/5 * * * *', keepAlive);
cron.schedule('*/3 * * * *', async () => {
    try { const d = await getPendingDeposits(); for (const x of d) await notifyAdminAboutDeposit(x); }
    catch (e) { logError('cron dep:', e.message); }
});
cron.schedule('*/10 * * * *', async () => {
    try {
        const wds = await getPendingWithdrawals();
        for (const w of wds) {
            const an = await analyzeWithdrawal(w);
            if (an.decision === 'reject') await rejectWithdrawal(w.id, 'AI: ' + an.reason);
        }
    } catch (e) { logError('cron wd:', e.message); }
});
cron.schedule('0 9,15,21 * * *', postPromotion);
cron.schedule('*/30 * * * *', checkAndAutoPause);
cron.schedule('0 23 * * *', sendDailyReport);

// ⭐ Invite-all batches — every 6 hours (4 per day)
cron.schedule('0 */6 * * *', runInviteAllBatch);

// ⭐ Daily single batch at 10 AM if invite-all is off
cron.schedule('0 10 * * *', async () => {
    try {
        const running = (await getSetting('invite_all_running')) === 'true';
        if (!running) await inviteUsersToGroup(INVITE_BATCH_SIZE);
    } catch (e) { logError('cron invite:', e.message); }
});

// ============================================================
// ADMIN POLLING
// ============================================================
async function pollAdminCommands() {
    try {
        const u = await bot.getUpdates({ offset: -1, limit: 1 });
        global.__ai_offset = (u[0]?.update_id || 0) + 1;
        setInterval(async () => {
            try {
                const ups = await bot.getUpdates({
                    offset: global.__ai_offset,
                    limit: 10, timeout: 5, allowed_updates: ['message'],
                });
                for (const x of ups) {
                    global.__ai_offset = x.update_id + 1;
                    if (x.message?.text?.startsWith('/ai_')) await handleAdminCommand(x.message);
                }
            } catch {}
        }, 3000);
    } catch (e) { logError('poll:', e.message); }
}

// ============================================================
// START
// ============================================================
(async () => {
    log('🚀 M-BINGO AI Agent v3');
    log(`👑 Admin: ${ADMIN_TELEGRAM_ID}`);
    log(`📣 Promo groups: ${PROMO_GROUP_IDS.join(', ') || 'none'}`);
    log(`📨 Invite target: ${PROMO_TARGET_GROUP || 'not set'}`);
    log(`🧠 AI: ${OPENAI_API_KEY ? AI_MODEL : 'DISABLED'}`);

    await initSettingsTable();
    await keepAlive();
    await inviter.init();   // log in the user client at startup
    pollAdminCommands();
    setTimeout(checkAndAutoPause, 10000);
    log('✅ Agent running.');
})();

process.on('unhandledRejection', e => logError('unhandled:', e.message || e));
process.on('uncaughtException', e => logError('uncaught:', e.message || e));
