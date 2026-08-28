// bot.js
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required!'); process.exit(1); }

const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 20;

console.log('🤖 M-BINGO Bot Configuration:');
console.log(`📡 API URL: ${API_URL}`);
console.log(`🎮 Game URL: ${GAME_URL}`);
console.log(`👑 Admin ID (Telegram): ${ADMIN_TELEGRAM_ID}`);
console.log(`🌐 Port: ${PORT}`);

// ============================================================
// DATABASE CONNECTION
// ============================================================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ DB error:', err.stack);
    else console.log('✅ Database connected');
});

// ============================================================
// ENSURE ADMIN USER & FETCH INTERNAL UUID
// ============================================================

let ADMIN_DB_ID = null;

async function ensureAdminUser() {
    try {
        // Check if admin user exists
        const result = await pool.query(
            `SELECT id, is_admin FROM users WHERE telegram_id = $1`,
            [ADMIN_TELEGRAM_ID]
        );

        if (result.rows.length === 0) {
            console.log('👑 Admin user not found, creating...');
            await pool.query(
                `INSERT INTO users (telegram_id, username, first_name, balance, is_admin, last_login)
                 VALUES ($1, $2, $3, 0, TRUE, CURRENT_TIMESTAMP)`,
                [ADMIN_TELEGRAM_ID, 'admin', 'Admin']
            );
            console.log('✅ Admin user created');
        } else if (result.rows[0].is_admin !== true) {
            console.log('👑 Upgrading user to admin...');
            await pool.query(
                `UPDATE users SET is_admin = TRUE WHERE telegram_id = $1`,
                [ADMIN_TELEGRAM_ID]
            );
            console.log('✅ User upgraded to admin');
        } else {
            console.log('✅ Admin user already exists');
        }

        // Now fetch the internal ID
        const idResult = await pool.query(
            `SELECT id FROM users WHERE telegram_id = $1 AND is_admin = TRUE`,
            [ADMIN_TELEGRAM_ID]
        );
        if (idResult.rows.length > 0) {
            ADMIN_DB_ID = idResult.rows[0].id;
            console.log(`✅ Admin DB ID: ${ADMIN_DB_ID}`);
        } else {
            console.error('❌ Could not retrieve admin DB ID');
        }
    } catch (error) {
        console.error('❌ Failed to ensure admin user:', error.message);
    }
}

// Call on startup
ensureAdminUser();

// ============================================================
// EXPRESS SERVER (Health Check & Admin Proxy)
// ============================================================

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

app.get('/', (req, res) => res.send('M-BINGO Bot is running ✅'));

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.json({ status: 'ok', database: 'connected' });
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

// ============================================================
// HELPERS
// ============================================================

async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId,
            username: username || `user_${telegramId}`,
            firstName,
            lastName: lastName || '',
            referralCode: referralCode || null
        });
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
    } catch (error) {
        return 0;
    }
}

function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' ETB';
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
// COMMAND HANDLERS (unchanged – same as before)
// ============================================================

// ... all command handlers (start, play, balance, etc.) are the same
// I'll include them in the final code block, but for brevity here I'll keep the essential parts.

// ============================================================
// CALLBACK QUERY HANDLER (with improved admin error handling)
// ============================================================

bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // Stake selection
    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
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

    // Main menu actions
    switch (data) {
        case 'play': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play'); break;
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
        case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
        case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
        case 'bonus': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/bonus'); break;
        case 'history': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/history'); break;
        case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
        case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
        case 'support':
            await bot.sendMessage(chatId, '📞 *Contact Support*\n\n👤 @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
            break;
        case 'patterns':
            await bot.sendMessage(chatId, `
🏆 *Winning Patterns*

✅ Row - 5 numbers in a horizontal line
✅ Column - 5 numbers in a vertical line
✅ Diagonal - 5 numbers diagonally
✅ Corners - All 4 corners
✅ Full House - All numbers on card
            `, { parse_mode: 'Markdown' });
            break;
        case 'copy_invite': {
            const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 *Your Invite Link:*\n\n${link}`, { parse_mode: 'Markdown' });
            break;
        }
        case 'back_to_menu':
            await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
            break;
        case 'cancel':
            await bot.sendMessage(chatId, '❌ Action cancelled.');
            break;

        // ---------- ADMIN ACTIONS ----------
        case 'admin_panel': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) { await bot.sendMessage(chatId, '⛔ Unauthorized.'); break; }
            await bot.sendMessage(chatId, '👑 *Admin Panel*', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Players', callback_data: 'admin_players' }],
                        [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                        [{ text: '💰 Add Balance', callback_data: 'admin_add_balance' }],
                        [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }],
                        [{ text: '📥 Deposit Requests', callback_data: 'admin_deposits' }],
                        [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
                        [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
            break;
        }

        case 'admin_players': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/players?adminId=${adminId}`);
                const players = response.data;
                let msg = '👥 *Players List*\n\n';
                players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name || 'Player'} - 💰 ${p.balance || 0} Birr\n`);
                msg += `\n📊 Total: ${players.length}`;
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
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
                await bot.sendMessage(chatId, `📊 *Server Stats*\n\n👥 Online: ${s.onlinePlayers || 0}\n🎮 Active Games: ${s.activeGames || 0}\n💰 Revenue Today: ${s.todayRevenue || 0} Birr\n📈 Total Users: ${s.totalPlayers || 0}`, { parse_mode: 'Markdown' });
            } catch (error) {
                const errMsg = error.response?.data?.error || error.message;
                await bot.sendMessage(chatId, `⚠️ Error fetching stats: ${errMsg}`);
            }
            break;
        }

        case 'admin_add_balance': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '💰 *Add Balance*\n\nUse: /addbalance [telegram_id] [amount]\n\nExample: /addbalance 123456789 100');
            break;
        }

        case 'admin_broadcast': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            await bot.sendMessage(chatId, '📢 *Send Broadcast*\n\nUse: /broadcast [your message]');
            break;
        }

        case 'admin_deposits': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/deposits?adminId=${adminId}`);
                const deposits = response.data;
                if (!deposits || deposits.length === 0) { await bot.sendMessage(chatId, 'No pending deposits.'); break; }
                let msg = '📥 *Pending Deposits*\n\n';
                deposits.forEach(d => msg += `👤 ${d.userName} (${d.userId})\n💰 ${formatCurrency(d.amount)}\n📱 ${d.method}\n🆔 ${d.reference}\n\n`);
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (error) {
                const errMsg = error.response?.data?.error || error.message;
                await bot.sendMessage(chatId, `⚠️ Error fetching deposits: ${errMsg}`);
            }
            break;
        }

        case 'admin_withdrawals': {
            if (userId.toString() !== ADMIN_TELEGRAM_ID) break;
            try {
                const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
                const response = await axios.get(`${API_URL}/api/admin/withdrawals?adminId=${adminId}`);
                const withdrawals = response.data;
                if (!withdrawals || withdrawals.length === 0) { await bot.sendMessage(chatId, 'No pending withdrawals.'); break; }
                let msg = '📤 *Pending Withdrawals*\n\n';
                withdrawals.forEach(w => msg += `👤 ${w.userName} (${w.userId})\n💰 ${formatCurrency(w.amount)}\n📱 ${w.method}\n🏦 ${w.destination}\n\n`);
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (error) {
                const errMsg = error.response?.data?.error || error.message;
                await bot.sendMessage(chatId, `⚠️ Error fetching withdrawals: ${errMsg}`);
            }
            break;
        }

        default:
            // No matching action
            break;
    }
});

// ============================================================
// ADMIN COMMANDS
// ============================================================

bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    const targetId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    try {
        const adminId = ADMIN_DB_ID || ADMIN_TELEGRAM_ID;
        await axios.post(`${API_URL}/api/admin/balance/add`, { userId: targetId, amount, adminId: adminId });
        await bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch (e) { await bot.sendMessage(chatId, '⚠️ Error adding balance.'); }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
    await bot.sendMessage(chatId, `📢 Broadcast sent: "${match[1]}"`);
});

// ============================================================
// NOTIFICATION POLLER (unchanged)
// ============================================================

setInterval(async () => {
    try {
        const deposits = await pool.query(
            `SELECT d.*, u.telegram_id FROM deposits d
             JOIN users u ON u.id = d.user_id
             WHERE d.status IN ('APPROVED', 'REJECTED') AND d.notified = FALSE`
        );
        for (let d of deposits.rows) {
            const msg = d.status === 'APPROVED'
                ? `💰 *Deposit Successful!* ${d.amount} Birr has been added to your balance.`
                : `❌ *Deposit Rejected.* Please try again or contact support.`;
            await bot.sendMessage(d.telegram_id, msg, { parse_mode: 'Markdown' });
            await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]);
        }

        const withdrawals = await pool.query(
            `SELECT w.*, u.telegram_id FROM withdrawals w
             JOIN users u ON u.id = w.user_id
             WHERE w.status IN ('APPROVED', 'REJECTED') AND w.notified = FALSE`
        );
        for (let w of withdrawals.rows) {
            const msg = w.status === 'APPROVED'
                ? `🏦 *Withdrawal Successful!* ${w.amount} Birr is on its way to your account.`
                : `❌ *Withdrawal Rejected.* Please try again.`;
            await bot.sendMessage(w.telegram_id, msg, { parse_mode: 'Markdown' });
            await pool.query('UPDATE withdrawals SET notified = TRUE WHERE id = $1', [w.id]);
        }
    } catch (e) {
        console.error('Notification Poller Error:', e.message);
    }
}, 10000);

// ============================================================
// START SERVER & BOT
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Admin API and health check on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

console.log('✅ M-BINGO Bot is running!');
console.log(`📍 Game URL: ${GAME_URL}`);
console.log(`📡 API URL: ${API_URL}`);
console.log(`👑 Admin Telegram ID: ${ADMIN_TELEGRAM_ID}`);
console.log(`👑 Admin DB ID: ${ADMIN_DB_ID || 'not yet loaded'}`);
