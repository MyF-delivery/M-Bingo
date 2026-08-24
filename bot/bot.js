// ============================================================
// M-BINGO TELEGRAM BOT - COMPLETE CHAT & MINI-APP INTEGRATION
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required!'); process.exit(1); }

const API_URL = process.env.API_URL || 'https://m-bingo-server.onrender.com';
const GAME_URL = process.env.GAME_URL || 'https://myf-delivery.github.io/M-Bingo/';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '555508978';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const PORT = process.env.PORT || 3000;
const REFERRAL_BONUS = 20;

// Database
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

// Express server (required for Render)
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://myf-delivery.github.io' }));
app.use(express.json());

app.get('/health', async (req, res) => {
    try { await pool.query('SELECT NOW()'); res.json({ status: 'ok', database: 'connected' }); }
    catch (e) { res.status(500).json({ status: 'error', database: 'disconnected' }); }
});

// Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });

// User state for multi-step flows
const userState = {};
const adminLoginState = {};

// Helpers
async function getOrCreateUser(telegramId, firstName, lastName, username, referralCode) {
    try {
        const response = await axios.post(`${API_URL}/api/users/register`, {
            telegramId, username: username || `user_${telegramId}`,
            firstName, lastName: lastName || '', referralCode: referralCode || null
        }, { headers: { 'x-bot-token': BOT_TOKEN } });
        return response.data.user;
    } catch (error) {
        console.error('Registration error:', error.response?.data?.message || error.message);
        return null;
    }
}

async function getUserBalance(telegramId) {
    try {
        const response = await axios.get(`${API_URL}/api/wallet/${telegramId}`);
        return response.data.balance || 0;
    } catch (error) { return 0; }
}

function formatCurrency(amount) {
    return amount.toLocaleString('en-US') + ' Birr';
}

function mainMenu(userId) {
    const isAdmin = userId.toString() === ADMIN_TELEGRAM_ID;
    const buttons = [
        [{ text: "🎮 Play Game", callback_data: 'play' }],
        [{ text: "💰 Balance", callback_data: 'balance' }, { text: "🏦 Deposit", callback_data: 'deposit' }],
        [{ text: "📤 Withdraw", callback_data: 'withdraw' }, { text: "🔄 Transfer", callback_data: 'transfer' }],
        [{ text: "🎁 Invite", callback_data: 'bonus' }, { text: "📖 Help", callback_data: 'help' }],
        [{ text: "📞 Support", callback_data: 'support' }, { text: "👤 Profile", callback_data: 'profile' }]
    ];
    if (isAdmin) buttons.push([{ text: "👑 Admin Panel", callback_data: 'admin_panel' }]);
    return { reply_markup: { inline_keyboard: buttons } };
}

async function ensureRegistered(telegramId, firstName, lastName, username) {
    try {
        const r = await axios.get(`${API_URL}/api/users/${telegramId}`);
        if (r.data.user) return true;
    } catch (e) {}
    const user = await getOrCreateUser(telegramId, firstName, lastName, username, null);
    return !!user;
}

// ============================================================
// COMMANDS
// ============================================================

// Start
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;
    const referralId = match ? parseInt(match[1]) : null;

    const isRegistered = await ensureRegistered(userId, firstName, lastName, username);

    if (isRegistered) {
        if (referralId && referralId !== userId) {
            try {
                await axios.post(`${API_URL}/api/referral/process`, { referrerId: referralId, newUserId: userId });
                await bot.sendMessage(referralId, `🎉 You earned ${REFERRAL_BONUS} Birr bonus!`);
            } catch (e) {}
        }
        const balance = await getUserBalance(userId);
        await bot.sendMessage(chatId, `👋 *Welcome back, ${firstName}!*\n\n💰 *Balance:* ${formatCurrency(balance)}`, {
            parse_mode: 'Markdown', ...mainMenu(userId)
        });
        return;
    }

    // New user: ask for contact
    const registerKeyboard = {
        reply_markup: {
            keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
            resize_keyboard: true, one_time_keyboard: true
        }
    };
    await bot.sendMessage(chatId, `📝 *Welcome to M-BINGO, ${firstName}!*\n\nPlease share your contact to register.`, {
        parse_mode: 'Markdown', ...registerKeyboard
    });
});

// Contact shared
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const contact = msg.contact;
    const firstName = msg.from.first_name || 'Player';
    const lastName = msg.from.last_name || '';
    const username = msg.from.username || `user_${userId}`;

    if (!contact || contact.user_id != userId) {
        return bot.sendMessage(chatId, '❌ Please share your own contact.');
    }

    const registered = await ensureRegistered(userId, firstName, lastName, username);

    if (registered) {
        const balance = await getUserBalance(userId);
        await bot.sendMessage(chatId, '✅ Registration complete!', { reply_markup: { remove_keyboard: true } });
        await bot.sendMessage(chatId, `✅ *Welcome, ${firstName}!*\n\n💰 *Balance:* ${formatCurrency(balance)}`, {
            parse_mode: 'Markdown', ...mainMenu(userId)
        });
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `🆕 New User: ${firstName} (${userId})`);
    } else {
        await bot.sendMessage(chatId, '❌ Registration failed. Please try again.');
    }
});

// Balance
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const balance = await getUserBalance(userId);
    await bot.sendMessage(chatId, `💰 *Your Balance:* ${formatCurrency(balance)}`, { parse_mode: 'Markdown' });
});

// Play
bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name;
    const lastName = msg.from.last_name || '';
    const username = msg.from.username;

    await ensureRegistered(userId, firstName, lastName, username);

    const stakeOptions = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "10 Birr", callback_data: 'stake_10' }, { text: "20 Birr", callback_data: 'stake_20' }],
                [{ text: "30 Birr", callback_data: 'stake_30' }, { text: "50 Birr", callback_data: 'stake_50' }],
                [{ text: "100 Birr", callback_data: 'stake_100' }, { text: "❌ Cancel", callback_data: 'cancel' }]
            ]
        }
    };
    await bot.sendMessage(chatId, '🎯 *Select your stake amount:*', { parse_mode: 'Markdown', ...stakeOptions });
});

// Deposit (opens mini app)
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=deposit&userId=${userId}`;
    await bot.sendMessage(chatId, '💰 *Deposit Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🏦 Open Deposit Form", web_app: { url: appUrl } }]] }
    });
});

// Withdraw (opens mini app)
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=withdraw&userId=${userId}`;
    await bot.sendMessage(chatId, '🏦 *Withdrawal Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🏦 Open Withdraw Form", web_app: { url: appUrl } }]] }
    });
});

// Transfer (opens mini app)
bot.onText(/\/transfer/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    await ensureRegistered(userId, msg.from.first_name, msg.from.last_name || '', msg.from.username);
    const appUrl = `${GAME_URL}?mode=transfer&userId=${userId}`;
    await bot.sendMessage(chatId, '🔄 *Transfer Section:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "🔄 Open Transfer Form", web_app: { url: appUrl } }]] }
    });
});

// Invite
bot.onText(/\/invite/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const inviteLink = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
    await bot.sendMessage(chatId, `🎁 *Invite Friends & Earn!*\n\nEarn *${REFERRAL_BONUS} Birr* per friend!\n\nYour Link:\n${inviteLink}`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "📤 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}` }],
                [{ text: "📋 Copy Link", callback_data: 'copy_invite' }]
            ]
        }
    });
});

// Help
bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `📖 *Commands*\n\n/start - Start & Register\n/play - Play\n/balance - Check balance\n/deposit - Deposit\n/withdraw - Withdraw\n/transfer - Transfer\n/invite - Invite\n/support - Support`, { parse_mode: 'Markdown' });
});

// Support
bot.onText(/\/support/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📞 *Support:* @frezerabiy\n📧 support@mbingo.com', { parse_mode: 'Markdown' });
});

// Profile
bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    try {
        const r = await axios.get(`${API_URL}/api/users/${userId}`);
        const user = r.data.user;
        await bot.sendMessage(chatId, `👤 *Profile*\n\n📛 Name: ${user.first_name}\n🆔 ID: ${user.telegramId}\n💰 Balance: ${user.balance} ETB\n🏆 Wins: ${user.wins || 0}`, { parse_mode: 'Markdown' });
    } catch (e) { await bot.sendMessage(chatId, '⚠️ Could not fetch profile.'); }
});

// ============================================================
// CALLBACK HANDLER
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    // Stake selection
    if (data.startsWith('stake_')) {
        const stake = parseInt(data.split('_')[1]);
        const appUrl = `${GAME_URL}?stake=${stake}&userId=${userId}`;
        await bot.sendMessage(chatId, `✅ Stake set to ${stake} Birr.\n\nClick below to select your cards:`, {
            reply_markup: { inline_keyboard: [[{ text: "🎮 Open Game", web_app: { url: appUrl } }]] }
        });
        return;
    }

    switch (data) {
        case 'play': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/play'); break;
        case 'balance': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/balance'); break;
        case 'deposit': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/deposit'); break;
        case 'withdraw': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/withdraw'); break;
        case 'transfer': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/transfer'); break;
        case 'bonus': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/invite'); break;
        case 'help': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/help'); break;
        case 'support': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/support'); break;
        case 'profile': bot.emit('text', { chat: { id: chatId }, from: { id: userId } }, '/profile'); break;
        case 'cancel': await bot.sendMessage(chatId, '❌ Action cancelled.'); break;
        case 'copy_invite': {
            const link = `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
            await bot.sendMessage(chatId, `📋 ${link}`);
            break;
        }
        case 'admin_panel':
            if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
            adminLoginState[chatId] = { step: 'USERNAME' };
            await bot.sendMessage(chatId, '🔐 *Enter Admin Username:*', { parse_mode: 'Markdown' });
            break;
    }
});

// ============================================================
// TEXT MESSAGE HANDLER (For Admin Login)
// ============================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    if (adminLoginState[chatId]) {
        const state = adminLoginState[chatId];
        if (state.step === 'USERNAME') {
            if (text !== ADMIN_USERNAME) { delete adminLoginState[chatId]; return bot.sendMessage(chatId, '❌ Invalid Username.'); }
            adminLoginState[chatId] = { step: 'PASSWORD' };
            return bot.sendMessage(chatId, '🔐 *Enter Admin Password:*', { parse_mode: 'Markdown' });
        }
        if (state.step === 'PASSWORD') {
            delete adminLoginState[chatId];
            let isPasswordValid = false;
            if (ADMIN_PASSWORD) { isPasswordValid = (text === ADMIN_PASSWORD); }
            else if (ADMIN_PASSWORD_HASH) { isPasswordValid = await bcrypt.compare(text, ADMIN_PASSWORD_HASH); }
            else if (text === 'admin123') { isPasswordValid = true; }

            if (!isPasswordValid) return bot.sendMessage(chatId, '❌ Invalid Password.');

            await bot.sendMessage(chatId, '👑 *Admin Panel*', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Players', callback_data: 'admin_players' }],
                        [{ text: '📥 Deposit Requests', callback_data: 'admin_deposits' }],
                        [{ text: '📤 Withdraw Requests', callback_data: 'admin_withdrawals' }],
                        [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                        [{ text: '🔙 Back', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        }
        return;
    }
});

// ============================================================
// ADMIN PANEL ACTIONS
// ============================================================
bot.on('callback_query', async (call) => {
    const chatId = call.message.chat.id;
    const userId = call.from.id;
    const data = call.data;
    bot.answerCallbackQuery(call.id);

    if (data === 'admin_players') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        try {
            const r = await axios.get(`${API_URL}/api/admin/players`);
            const players = r.data;
            let msg = '👥 *Players List*\n\n';
            players.slice(0, 20).forEach((p, i) => msg += `${i+1}. ${p.first_name} - 💰 ${p.balance} Birr\n`);
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching players.'); }
        return;
    }

    if (data === 'admin_deposits' || data === 'admin_withdrawals') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        const isDeposit = data === 'admin_deposits';
        const url = isDeposit ? `${API_URL}/api/admin/deposits` : `${API_URL}/api/admin/withdrawals`;
        try {
            const r = await axios.get(url);
            const items = r.data;
            if (!items || items.length === 0) return bot.sendMessage(chatId, 'No pending items.');
            let msg = isDeposit ? '📥 *Pending Deposits*\n\n' : '📤 *Pending Withdrawals*\n\n';
            items.forEach((item) => {
                msg += `👤 ${item.userName} (${item.userId})\n💰 ${formatCurrency(item.amount)}\n🆔 ${item.txnId || item.account}\n\n`;
            });
            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching items.'); }
        return;
    }

    if (data === 'admin_stats') {
        if (userId.toString() !== ADMIN_TELEGRAM_ID) return bot.sendMessage(chatId, '⛔ Unauthorized.');
        try {
            const r = await axios.get(`${API_URL}/api/admin/stats`);
            const s = r.data;
            await bot.sendMessage(chatId, `📊 *Stats*\n\n👥 Players: ${s.totalPlayers}\n🎮 Active Games: ${s.activeGames}`, { parse_mode: 'Markdown' });
        } catch (e) { await bot.sendMessage(chatId, '⚠️ Error fetching stats.'); }
        return;
    }

    if (data === 'back_to_menu') {
        await bot.sendMessage(chatId, '🎯 *Welcome back!*', { parse_mode: 'Markdown', ...mainMenu(userId) });
        return;
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
        await axios.post(`${API_URL}/api/admin/balance/add`, { userId: targetId, amount, adminId: userId });
        await bot.sendMessage(chatId, `✅ Added ${amount} Birr to player!`);
    } catch (e) { await bot.sendMessage(chatId, '⚠️ Error adding balance.'); }
});

// ============================================================
// NOTIFICATION POLLER (Admin Approvals)
// ============================================================
setInterval(async () => {
    try {
        const deposits = await pool.query(
            `SELECT d.*, u.telegram_id FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status IN ('APPROVED', 'REJECTED') AND d.notified = FALSE`
        );
        for (let d of deposits.rows) {
            const msg = d.status === 'APPROVED'
                ? `💰 Deposit Successful! ${d.amount} Birr added.`
                : `❌ Deposit Rejected. Please try again.`;
            await bot.sendMessage(d.telegram_id, msg, { parse_mode: 'Markdown' });
            await pool.query('UPDATE deposits SET notified = TRUE WHERE id = $1', [d.id]);
        }

        const withdrawals = await pool.query(
            `SELECT w.*, u.telegram_id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status IN ('APPROVED', 'REJECTED') AND w.notified = FALSE`
        );
        for (let w of withdrawals.rows) {
            const msg = w.status === 'APPROVED'
                ? `🏦 Withdrawal Successful! ${w.amount} Birr sent.`
                : `❌ Withdrawal Rejected. Please try again.`;
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
    console.log(`🌐 Admin API on port ${PORT}`);
});

bot.setChatMenuButton({
    menu_button: { type: 'web_app', text: '🎮 Play M-BINGO', web_app: { url: GAME_URL } }
}).catch(() => {});

console.log('✅ M-BINGO Bot is running!');
